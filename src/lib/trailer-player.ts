import type { MpvEvent } from 'tauri-plugin-libmpv-api';
import { errorMessage } from '$lib/errors';
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
    cancelled: () => boolean,
    replacing: boolean
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
  request: TrailerPlaybackRequest;
  mediaVersion: number;
  fileStarted: boolean;
  fileLoaded: boolean;
  playbackRestarted: boolean;
  playlistEntryId: number | null;
  outgoingPlaylistEntryId: number | null;
  mediaWasReplaced: boolean;
  aborted: boolean;
  autoplay: boolean;
  readyAt: number;
  observedTime: number;
  userSeeked: boolean;
  streamRetries: number;
};

type PendingTrailerStart = {
  request: TrailerPlaybackRequest;
  volume: number;
  muted: boolean;
  version: number;
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
export const MAX_TRAILER_STREAM_RETRIES = 2;
const STREAM_END_SLACK_SECONDS = 1;
const STREAM_FAILURE_LEAD_SECONDS = 5;

export function trailerStreamEndedEarly(
  time: number,
  duration: number,
  secondsSinceReady: number
): boolean {
  return (
    duration > STREAM_FAILURE_LEAD_SECONDS &&
    time >= duration - STREAM_END_SLACK_SECONDS &&
    time > secondsSinceReady + STREAM_FAILURE_LEAD_SECONDS
  );
}

export class TrailerPlayerController<TContext> {
  private state: TrailerPlaybackState | null = null;
  private session: TrailerSession<TContext> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private cancellationVersion = 0;
  private pendingStart: PendingTrailerStart | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly driver: TrailerPlayerDriver<TContext>;
  private readonly onStateChange: (state: TrailerPlaybackState | null) => void;
  private readonly onError: (message: string) => void;
  private readonly now: () => number;

  constructor(
    driver: TrailerPlayerDriver<TContext>,
    onStateChange: (state: TrailerPlaybackState | null) => void,
    onError: (message: string) => void,
    now: () => number = Date.now
  ) {
    this.driver = driver;
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.now = now;
  }

  get active(): boolean {
    return this.state !== null;
  }

  start(request: TrailerPlaybackRequest, volume: number, muted: boolean): Promise<void> {
    const version = this.cancellationVersion;
    return this.enqueue(async () => {
      if (version !== this.cancellationVersion) return;

      const activeSession = this.session;
      const activeState = this.state;
      if (
        activeSession &&
        activeState &&
        activeState.url === request.url &&
        activeState.status !== 'closing' &&
        activeState.status !== 'error' &&
        !activeSession.aborted
      ) {
        activeSession.autoplay = true;
        if (this.isControllable(activeState) && activeState.paused) {
          this.update({ paused: false });
          try {
            await this.driver.setPaused(false);
          } catch (reason) {
            const message = errorMessage(reason);
            this.fail(message);
            await this.abort(activeSession, message);
          }
        }
        return;
      }
      if (activeSession && activeState?.status === 'searching' && !activeSession.aborted) {
        this.pendingStart = { request, volume, muted, version };
        return;
      }
      if (
        activeSession &&
        activeState &&
        this.isControllable(activeState) &&
        !activeSession.aborted
      ) {
        this.pendingStart = null;
        const replacement = this.initialState(
          request,
          activeState.volume,
          activeState.muted
        );
        await this.loadMedia(activeSession, request, replacement, version);
        return;
      }
      if (activeSession && activeState?.status === 'closing') return;
      if (activeSession) {
        this.clearStartTimeout();
        try {
          await this.driver.teardown(activeSession.context, activeSession.mediaWasReplaced);
        } catch (reason) {
          const message = errorMessage(reason);
          this.onError(message);
          this.update({
            status: 'error',
            paused: true,
            error: `The trailer player could not recover: ${message}`
          });
          return;
        }
        if (this.session === activeSession) this.session = null;
      }

      this.pendingStart = null;
      const initial = this.initialState(request, volume, muted);
      let context: TContext;
      try {
        context = this.driver.open(request);
      } catch (reason) {
        this.setState({
          ...initial,
          status: 'error',
          paused: true,
          error: errorMessage(reason)
        });
        return;
      }

      const session: TrailerSession<TContext> = {
        context,
        request,
        mediaVersion: 0,
        fileStarted: false,
        fileLoaded: false,
        playbackRestarted: false,
        playlistEntryId: null,
        outgoingPlaylistEntryId: null,
        mediaWasReplaced: false,
        aborted: false,
        autoplay: true,
        readyAt: 0,
        observedTime: 0,
        userSeeked: false,
        streamRetries: 0
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
        await this.loadMedia(session, request, initial, version);
      } catch (reason) {
        if (!this.isCurrent(session, version)) return;
        const message = errorMessage(reason);
        this.fail(message);
        await this.abort(session, message);
      }
    });
  }

  close(): Promise<void> {
    this.cancellationVersion += 1;
    this.pendingStart = null;
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
        const message = errorMessage(reason);
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
    session.userSeeked = true;
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
    const session = this.session;
    const state = this.state;
    if (!session || !state || state.status === 'closing' || state.status === 'error') return;

    if (name === 'pause') {
      this.update({ paused: Boolean(data) });
    } else if (name === 'time-pos') {
      const time = this.nonNegativeNumber(data);
      session.observedTime = time;
      this.update({ time });
      this.detectFailedStream(session, time);
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

    if (
      event.event === 'end-file' &&
      session.outgoingPlaylistEntryId !== null &&
      event.playlist_entry_id === session.outgoingPlaylistEntryId
    ) {
      session.outgoingPlaylistEntryId = null;
      return;
    }
    if (session.outgoingPlaylistEntryId !== null) return;

    if (event.event === 'start-file' && state.status === 'searching') {
      this.resetMediaEvents(session);
      session.fileStarted = true;
      session.playlistEntryId = event.playlist_entry_id;
      this.update({ time: 0, duration: 0, error: '' });
      return;
    }

    if (event.event === 'file-loaded' && session.fileStarted && state.status === 'searching') {
      session.fileLoaded = true;
      if (session.autoplay) {
        this.update({ paused: false });
        void this.runControl(session, () => this.driver.setPaused(false));
      }
      return;
    }

    if (
      event.event === 'playback-restart' &&
      session.fileStarted &&
      session.fileLoaded &&
      state.status === 'searching'
    ) {
      session.playbackRestarted = true;
      this.markReadyIfLoaded(session);
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
      this.resetMediaEvents(session);
      return;
    }
    if (event.reason === 'stop') return;

    this.clearStartTimeout();
    if (event.reason === 'error' || state.status === 'searching') {
      this.resetMediaEvents(session);
      if (this.queuePendingStart(session)) return;
      const message =
        'This trailer could not be opened. YouTube may have changed its playback requirements.';
      this.failAndAbort(session, message);
      return;
    }
    this.resetMediaEvents(session);
    this.update({ status: 'ready', paused: true, time: state.duration || state.time });
  }

  dispose(): void {
    this.cancellationVersion += 1;
    this.pendingStart = null;
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

  private initialState(
    request: TrailerPlaybackRequest,
    volume: number,
    muted: boolean
  ): TrailerPlaybackState {
    const { viewport: _, ...media } = request;
    return {
      ...media,
      status: 'searching',
      error: '',
      paused: false,
      time: 0,
      duration: 0,
      volume,
      muted
    };
  }

  private async loadMedia(
    session: TrailerSession<TContext>,
    request: TrailerPlaybackRequest,
    initial: TrailerPlaybackState,
    version: number,
    retry = false
  ): Promise<void> {
    const replacing = session.mediaWasReplaced;
    session.request = request;
    session.observedTime = 0;
    session.userSeeked = false;
    if (!retry) session.streamRetries = 0;
    session.mediaVersion += 1;
    session.outgoingPlaylistEntryId = session.fileStarted
      ? session.playlistEntryId
      : null;
    this.resetMediaEvents(session);
    session.aborted = false;
    session.autoplay = true;
    session.mediaWasReplaced = true;
    this.setState(initial);
    this.armStartTimeout(session);

    try {
      await this.driver.load(
        request,
        initial,
        () => !this.isCurrent(session, version),
        replacing
      );
    } catch (reason) {
      if (!this.isCurrent(session, version)) return;
      const message = errorMessage(reason);
      this.fail(message);
      await this.abort(session, message);
    }
  }

  private detectFailedStream(session: TrailerSession<TContext>, time: number): void {
    const state = this.state;
    if (
      !state ||
      !this.isControllable(state) ||
      session.userSeeked ||
      !trailerStreamEndedEarly(time, state.duration, (this.now() - session.readyAt) / 1000)
    ) {
      return;
    }
    session.userSeeked = true;
    if (session.streamRetries >= MAX_TRAILER_STREAM_RETRIES) {
      this.failAndAbort(
        session,
        'YouTube refused the trailer stream. Try again in a moment.'
      );
      return;
    }
    const mediaVersion = session.mediaVersion;
    const version = this.cancellationVersion;
    void this.enqueue(async () => {
      const current = this.state;
      if (
        !current ||
        !this.isCurrent(session, version) ||
        session.mediaVersion !== mediaVersion ||
        !this.isControllable(current)
      ) {
        return;
      }
      session.streamRetries += 1;
      const replacement = this.initialState(session.request, current.volume, current.muted);
      await this.loadMedia(session, session.request, replacement, version, true);
    });
  }

  private resetMediaEvents(session: TrailerSession<TContext>): void {
    session.fileStarted = false;
    session.fileLoaded = false;
    session.playbackRestarted = false;
    session.playlistEntryId = null;
  }

  private queuePendingStart(session: TrailerSession<TContext>): boolean {
    const pending = this.pendingStart;
    if (
      !pending ||
      this.session !== session ||
      pending.version !== this.cancellationVersion
    ) {
      return false;
    }

    void this.enqueue(async () => {
      const state = this.state;
      if (
        !state ||
        !this.isCurrent(session, pending.version) ||
        state.status === 'closing'
      ) {
        if (this.pendingStart === pending) this.pendingStart = null;
        return;
      }
      if (state.status === 'error' || session.aborted) {
        if (this.pendingStart === pending) this.pendingStart = null;
        void this.start(pending.request, pending.volume, pending.muted);
        return;
      }
      if (this.pendingStart !== pending) return;
      this.pendingStart = null;
      const replacement = this.initialState(pending.request, state.volume, state.muted);
      await this.loadMedia(session, pending.request, replacement, pending.version);
    });
    return true;
  }

  private runControl(session: TrailerSession<TContext>, task: () => Promise<void>): Promise<void> {
    const mediaVersion = session.mediaVersion;
    return this.enqueue(async () => {
      if (
        this.session !== session ||
        session.mediaVersion !== mediaVersion ||
        this.state?.status === 'closing'
      ) {
        return;
      }
      try {
        await task();
      } catch (reason) {
        if (this.session === session) this.failAndAbort(session, errorMessage(reason));
      }
    });
  }

  private armStartTimeout(session: TrailerSession<TContext>): void {
    this.clearStartTimeout();
    const mediaVersion = session.mediaVersion;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (
        this.session !== session ||
        session.mediaVersion !== mediaVersion ||
        this.state?.status !== 'searching'
      ) {
        return;
      }
      if (this.queuePendingStart(session)) return;
      const message = 'The trailer search timed out before playback could start.';
      this.failAndAbort(session, message);
    }, START_TIMEOUT_MS);
  }

  private failAndAbort(session: TrailerSession<TContext>, message: string): void {
    this.fail(message);
    void this.enqueue(async () => {
      await this.abort(session, message);
      const pending = this.pendingStart;
      if (
        !pending ||
        this.session !== session ||
        pending.version !== this.cancellationVersion
      ) {
        return;
      }
      this.pendingStart = null;
      void this.start(pending.request, pending.volume, pending.muted);
    });
  }

  private async abort(session: TrailerSession<TContext>, message: string): Promise<void> {
    if (this.session !== session || session.aborted) return;
    try {
      await this.driver.abort(session.context, session.mediaWasReplaced);
      session.aborted = true;
    } catch (reason) {
      if (this.session === session) {
        const abortMessage = errorMessage(reason);
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

  private markReadyIfLoaded(session: TrailerSession<TContext>): void {
    const state = this.state;
    if (
      this.session !== session ||
      !state ||
      state.status !== 'searching' ||
      !session.fileStarted ||
      !session.fileLoaded ||
      !session.playbackRestarted
    ) {
      return;
    }

    this.clearStartTimeout();
    session.readyAt = this.now();
    this.update({
      status: 'ready',
      paused: !session.autoplay,
      time: 0,
      error: ''
    });
    if (this.queuePendingStart(session)) return;
    this.detectFailedStream(session, session.observedTime);
    if (session.autoplay) return;
    void this.runControl(session, () => this.driver.setPaused(true));
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

}
