import type { MpvEvent } from 'tauri-plugin-libmpv-api';
import type { TrailerPlaybackRequest } from '$lib/types';

export type TrailerPlaybackStatus =
  | 'searching'
  | 'ready'
  | 'buffering'
  | 'error'
  | 'closing';

export type TrailerPlaybackState = Omit<TrailerPlaybackRequest, 'viewport'> & {
  status: TrailerPlaybackStatus;
  error: string;
  paused: boolean;
  time: number;
  duration: number;
  volume: number;
  muted: boolean;
  mediaTitle?: string;
};

export interface TrailerPlayerDriver<TContext> {
  open: (request: TrailerPlaybackRequest) => TContext;
  prepare: (
    context: TContext,
    request: TrailerPlaybackRequest,
    initial: TrailerPlaybackState,
    cancelled: () => boolean
  ) => Promise<void>;
  load: (
    request: TrailerPlaybackRequest,
    initial: TrailerPlaybackState,
    cancelled: () => boolean
  ) => Promise<void>;
  abort: (context: TContext, mediaWasReplaced: boolean) => Promise<void>;
  teardown: (context: TContext, mediaWasReplaced: boolean) => Promise<void>;
  setPaused: (paused: boolean) => Promise<void>;
  seek: (time: number) => Promise<void>;
  setVolume: (volume: number) => Promise<void>;
  setMuted: (muted: boolean) => Promise<void>;
}

type TrailerSession<TContext> = {
  context: TContext;
  fileStarted: boolean;
  playlistEntryId: number | null;
  mediaWasReplaced: boolean;
  aborted: boolean;
  autoplay: boolean;
};

type TrailerPropertyName =
  | 'pause'
  | 'time-pos'
  | 'duration'
  | 'volume'
  | 'mute'
  | 'media-title'
  | 'paused-for-cache';

const START_TIMEOUT_MS = 30_000;

export class TrailerPlayerController<TContext> {
  private state: TrailerPlaybackState | null = null;
  private session: TrailerSession<TContext> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private cancellationVersion = 0;
  private startTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly driver: TrailerPlayerDriver<TContext>,
    private readonly onStateChange: (state: TrailerPlaybackState | null) => void,
    private readonly onError: (message: string) => void
  ) {}

  get active(): boolean {
    return this.state !== null;
  }

  start(request: TrailerPlaybackRequest, volume: number, muted: boolean): Promise<void> {
    const version = this.cancellationVersion;
    return this.enqueue(async () => {
      if (this.session || version !== this.cancellationVersion) return;

      const { viewport: _, ...media } = request;
      const initial: TrailerPlaybackState = {
        ...media,
        status: 'searching',
        error: '',
        paused: false,
        time: 0,
        duration: 0,
        volume,
        muted
      };

      let context: TContext;
      try {
        context = this.driver.open(request);
      } catch (reason) {
        this.setState({
          ...initial,
          status: 'error',
          paused: true,
          error: this.message(reason)
        });
        return;
      }

      const session: TrailerSession<TContext> = {
        context,
        fileStarted: false,
        playlistEntryId: null,
        mediaWasReplaced: false,
        aborted: false,
        autoplay: true
      };
      this.session = session;
      this.setState(initial);

      try {
        await this.driver.prepare(
          context,
          request,
          initial,
          () => !this.isCurrent(session, version)
        );
        if (!this.isCurrent(session, version)) return;

        session.mediaWasReplaced = true;
        this.armStartTimeout(session);
        await this.driver.load(
          request,
          initial,
          () => !this.isCurrent(session, version)
        );
      } catch (reason) {
        if (!this.isCurrent(session, version)) return;
        this.clearStartTimeout();
        const message = this.message(reason);
        this.fail(message);
        await this.abort(session, message);
      }
    });
  }

  close(): Promise<void> {
    this.cancellationVersion += 1;
    if (this.state) this.update({ status: 'closing', paused: true, error: '' });
    return this.enqueue(async () => {
      const session = this.session;
      if (!session) {
        this.clearStartTimeout();
        this.setState(null);
        return;
      }

      this.clearStartTimeout();
      try {
        await this.driver.teardown(session.context, session.mediaWasReplaced);
      } catch (reason) {
        const message = this.message(reason);
        this.onError(message);
        this.update({
          status: 'error',
          paused: true,
          error: `The trailer could not be closed safely: ${message}`
        });
        return;
      }
      if (this.session === session) this.session = null;
      this.setState(null);
    });
  }

  pause(): Promise<void> {
    const session = this.session;
    if (!session || !this.state || this.state.status === 'closing') return Promise.resolve();
    session.autoplay = false;
    this.update({ paused: true });
    return this.runControl(session, () => this.driver.setPaused(true));
  }

  togglePlayback(): Promise<void> {
    const session = this.session;
    const state = this.state;
    if (!session || !state || !this.isControllable(state)) return Promise.resolve();

    const paused = !state.paused;
    session.autoplay = !paused;
    this.update({ paused });
    return this.runControl(session, async () => {
      if (!paused && state.duration > 0 && state.time >= state.duration - 0.25) {
        await this.driver.seek(0);
        this.updateFor(session, { time: 0 });
      }
      await this.driver.setPaused(paused);
    });
  }

  seek(time: number): Promise<void> {
    const session = this.session;
    const state = this.state;
    if (!session || !state || !this.isControllable(state) || state.duration <= 0) {
      return Promise.resolve();
    }

    const target = Math.max(0, Math.min(state.duration, time));
    this.update({ time: target });
    return this.runControl(session, () => this.driver.seek(target));
  }

  changeVolume(volume: number): Promise<void> {
    const session = this.session;
    const state = this.state;
    if (!session || !state || state.status === 'closing') return Promise.resolve();

    const nextVolume = Math.max(0, Math.min(100, volume));
    this.update({ volume: nextVolume, muted: false });
    return this.runControl(session, async () => {
      await this.driver.setMuted(false);
      await this.driver.setVolume(nextVolume);
    });
  }

  toggleMute(): Promise<void> {
    const session = this.session;
    const state = this.state;
    if (!session || !state || state.status === 'closing') return Promise.resolve();

    const muted = !state.muted;
    this.update({ muted });
    return this.runControl(session, () => this.driver.setMuted(muted));
  }

  handleProperty(name: TrailerPropertyName, data: unknown): void {
    const state = this.state;
    if (!this.session || !state || state.status === 'closing' || state.status === 'error') return;

    if (name === 'pause') {
      this.update({ paused: Boolean(data) });
    } else if (name === 'time-pos') {
      this.update({ time: this.nonNegativeNumber(data) });
    } else if (name === 'duration') {
      this.update({ duration: this.nonNegativeNumber(data) });
    } else if (name === 'volume') {
      this.update({ volume: this.nonNegativeNumber(data) });
    } else if (name === 'mute') {
      this.update({ muted: Boolean(data) });
    } else if (name === 'media-title') {
      this.update({ mediaTitle: typeof data === 'string' ? data : undefined });
    } else if (name === 'paused-for-cache' && this.isControllable(state)) {
      this.update({ status: Boolean(data) ? 'buffering' : 'ready' });
    }
  }

  handleEvent(event: MpvEvent): void {
    const session = this.session;
    const state = this.state;
    if (!session || !state || state.status === 'closing' || state.status === 'error') return;

    if (event.event === 'start-file' && state.status === 'searching') {
      session.fileStarted = true;
      session.playlistEntryId = event.playlist_entry_id;
      return;
    }

    if (event.event === 'file-loaded' && session.fileStarted && state.status === 'searching') {
      if (session.autoplay) {
        this.update({ paused: false });
        void this.runControl(session, () => this.driver.setPaused(false));
      }
      return;
    }

    if (event.event === 'playback-restart' && session.fileStarted && state.status === 'searching') {
      this.clearStartTimeout();
      this.update({ status: 'ready', paused: !session.autoplay, error: '' });
      if (!session.autoplay) {
        void this.runControl(session, () => this.driver.setPaused(true));
      }
      return;
    }

    if (
      event.event !== 'end-file' ||
      !session.fileStarted ||
      event.playlist_entry_id !== session.playlistEntryId
    ) {
      return;
    }
    if (event.reason === 'redirect') {
      session.fileStarted = false;
      session.playlistEntryId = null;
      return;
    }
    if (event.reason === 'stop') return;

    this.clearStartTimeout();
    if (event.reason === 'error' || state.status === 'searching') {
      const message =
        'This trailer could not be opened. YouTube may have changed its playback requirements.';
      this.failAndAbort(session, message);
      return;
    }
    this.update({ status: 'ready', paused: true, time: state.duration || state.time });
  }

  dispose(): void {
    this.cancellationVersion += 1;
    this.clearStartTimeout();
    this.session = null;
    this.state = null;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const operation = this.queue.then(task, task);
    this.queue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private runControl(session: TrailerSession<TContext>, task: () => Promise<void>): Promise<void> {
    return this.enqueue(async () => {
      if (this.session !== session || this.state?.status === 'closing') return;
      try {
        await task();
      } catch (reason) {
        if (this.session === session) this.failAndAbort(session, this.message(reason));
      }
    });
  }

  private armStartTimeout(session: TrailerSession<TContext>): void {
    this.clearStartTimeout();
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (this.session !== session || this.state?.status !== 'searching') return;
      const message = 'The trailer search timed out before playback could start.';
      this.failAndAbort(session, message);
    }, START_TIMEOUT_MS);
  }

  private failAndAbort(session: TrailerSession<TContext>, message: string): void {
    this.fail(message);
    void this.enqueue(() => this.abort(session, message));
  }

  private async abort(session: TrailerSession<TContext>, message: string): Promise<void> {
    if (this.session !== session || session.aborted) return;
    try {
      await this.driver.abort(session.context, session.mediaWasReplaced);
      session.aborted = true;
    } catch (reason) {
      if (this.session === session) {
        const abortMessage = this.message(reason);
        this.onError(abortMessage);
        this.update({
          status: 'error',
          paused: true,
          error: `${message} The native player could not be stopped safely: ${abortMessage}`
        });
      }
    }
  }

  private clearStartTimeout(): void {
    if (this.startTimer !== null) clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  private isCurrent(session: TrailerSession<TContext>, version: number): boolean {
    return this.session === session && version === this.cancellationVersion;
  }

  private isControllable(state: TrailerPlaybackState): boolean {
    return state.status === 'ready' || state.status === 'buffering';
  }

  private update(patch: Partial<TrailerPlaybackState>): void {
    if (!this.state) return;
    this.setState({ ...this.state, ...patch });
  }

  private updateFor(
    session: TrailerSession<TContext>,
    patch: Partial<TrailerPlaybackState>
  ): void {
    if (this.session === session) this.update(patch);
  }

  private fail(message: string): void {
    this.clearStartTimeout();
    this.update({ status: 'error', error: message, paused: true });
  }

  private setState(state: TrailerPlaybackState | null): void {
    this.state = state;
    this.onStateChange(state);
  }

  private nonNegativeNumber(value: unknown): number {
    const number = Number(value ?? 0);
    return Number.isFinite(number) ? Math.max(0, number) : 0;
  }

  private message(reason: unknown): string {
    return reason instanceof Error ? reason.message : String(reason);
  }
}
