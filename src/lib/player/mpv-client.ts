import type * as MpvModule from 'tauri-plugin-libmpv-api';
import type {
  MpvConfig,
  MpvEvent,
  MpvEventFromProperties,
  MpvObservableProperty,
  VideoMarginRatio
} from 'tauri-plugin-libmpv-api';
import { errorMessage, toError } from '$lib/errors';

export type MpvApi = Pick<
  typeof MpvModule,
  | 'init'
  | 'destroy'
  | 'command'
  | 'setProperty'
  | 'getProperty'
  | 'observeProperties'
  | 'listenEvents'
  | 'setVideoMarginRatio'
>;

export type MpvFlagProperty = 'pause' | 'mute';
export type MpvNumberProperty = 'volume' | 'speed';
export type MpvTrackProperty = 'aid' | 'sid';
export type MpvTrackChoice = number | 'auto' | 'no';

export function isMissingMpvInstance(reason: unknown): boolean {
  const message = errorMessage(reason);
  return message.includes('is not initialized') || message.includes('mpv instance not found');
}

export class MpvCommands {
  private readonly api: MpvApi;
  private readonly windowLabel: string;

  constructor(api: MpvApi, windowLabel: string) {
    this.api = api;
    this.windowLabel = windowLabel;
  }

  setFlag(name: MpvFlagProperty, value: boolean): Promise<void> {
    return this.api.setProperty(name, value, this.windowLabel);
  }

  setNumber(name: MpvNumberProperty, value: number): Promise<void> {
    return this.api.setProperty(name, value, this.windowLabel);
  }

  setSubtitleLanguages(languages: string): Promise<void> {
    return this.api.setProperty('slang', languages, this.windowLabel);
  }

  selectTrack(property: MpvTrackProperty, choice: MpvTrackChoice): Promise<void> {
    return this.api.setProperty(property, String(choice), this.windowLabel);
  }

  seek(time: number): Promise<void> {
    return this.api.command('seek', [time, 'absolute+exact'], this.windowLabel);
  }

  loadFile(url: string, options?: string): Promise<void> {
    return this.api.command(
      'loadfile',
      options === undefined ? [url, 'replace'] : [url, 'replace', -1, options],
      this.windowLabel
    );
  }

  stop(): Promise<void> {
    return this.api.command('stop', [], this.windowLabel);
  }

  setMargins(ratio: VideoMarginRatio): Promise<void> {
    return this.api.setVideoMarginRatio(ratio, this.windowLabel);
  }

  readPath(): Promise<string | null> {
    return this.api.getProperty<string | null>('path', 'string', this.windowLabel);
  }

  readPausedForCache(): Promise<boolean> {
    return this.api.getProperty<boolean>('paused-for-cache', 'flag', this.windowLabel);
  }

  readTimePosition(): Promise<number | null> {
    return this.api.getProperty<number | null>('time-pos', 'double', this.windowLabel);
  }
}

export interface MpvSession {
  readonly commands: MpvCommands;
  run<T>(operation: (mpv: MpvCommands) => Promise<T>): Promise<T>;
}

export type MpvClientOptions<P extends readonly MpvObservableProperty[]> = {
  windowLabel: string;
  observedProperties: P;
  enabled: () => boolean;
  initialOptions: () => NonNullable<MpvConfig['initialOptions']>;
  initialMargins: () => VideoMarginRatio | null;
  onProperty: (event: MpvEventFromProperties<P[number]>) => void;
  onEvent: (event: MpvEvent) => void;
  loadTimeoutMs: number;
};

type LoadWaiter = {
  expectedPathPrefix: string;
  resolve: () => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class MpvClient<P extends readonly MpvObservableProperty[]> implements MpvSession {
  readonly commands: MpvCommands;
  private readonly api: MpvApi;
  private readonly options: MpvClientOptions<P>;
  private readyValue = false;
  private initializing: Promise<void> | null = null;
  private unlisteners: Array<() => void> = [];
  private loadWaiter: LoadWaiter | null = null;

  constructor(api: MpvApi, options: MpvClientOptions<P>) {
    this.api = api;
    this.options = options;
    this.commands = new MpvCommands(api, options.windowLabel);
  }

  get ready(): boolean {
    return this.readyValue;
  }

  get settled(): boolean {
    return this.readyValue && this.initializing === null;
  }

  async ensure(): Promise<void> {
    if (!this.options.enabled()) return;
    if (this.initializing) return this.initializing;
    if (this.readyValue) return;

    this.initializing = this.initialize();
    try {
      await this.initializing;
    } catch (reason) {
      this.reset();
      throw reason;
    } finally {
      this.initializing = null;
    }
  }

  async run<T>(operation: (mpv: MpvCommands) => Promise<T>): Promise<T> {
    await this.ensure();
    try {
      return await operation(this.commands);
    } catch (reason) {
      if (!isMissingMpvInstance(reason)) throw reason;
      this.reset();
      await this.ensure();
      return operation(this.commands);
    }
  }

  async syncMargins(ratio: VideoMarginRatio): Promise<void> {
    if (!this.options.enabled() || !this.settled) return;
    await this.commands.setMargins(ratio).catch((reason) => {
      if (!isMissingMpvInstance(reason)) console.warn('The video viewport could not be synced.', reason);
    });
  }

  async loadAndWait(url: string, expectedPathPrefix: string): Promise<void> {
    const loadResult = this.waitForFileLoad(expectedPathPrefix).then(
      () => ({ loaded: true as const }),
      (reason: Error) => ({ loaded: false as const, reason })
    );
    try {
      await this.run((mpv) => mpv.loadFile(url, 'pause=yes'));
      const result = await loadResult;
      if (!result.loaded) throw result.reason;
    } catch (reason) {
      this.rejectLoadWaiter(toError(reason));
      await loadResult;
      throw reason;
    }
  }

  async destroy(): Promise<void> {
    this.reset();
    await this.api.destroy(this.options.windowLabel);
  }

  reset(): void {
    this.readyValue = false;
    this.rejectLoadWaiter(new Error('The mpv instance was reset during a media load.'));
    this.unlisten();
  }

  dispose(): void {
    this.rejectLoadWaiter(new Error('The player was closed.'));
    this.unlisten();
  }

  private async initialize(): Promise<void> {
    const { windowLabel, observedProperties } = this.options;
    await this.api.init(
      { initialOptions: this.options.initialOptions(), observedProperties },
      windowLabel
    );
    this.unlisten();
    this.unlisteners.push(
      await this.api.observeProperties(observedProperties, this.options.onProperty, windowLabel)
    );
    this.unlisteners.push(await this.api.listenEvents((event) => this.handleEvent(event), windowLabel));
    const margins = this.options.initialMargins();
    if (margins) await this.commands.setMargins(margins);
    this.readyValue = true;
  }

  private handleEvent(event: MpvEvent): void {
    if (event.event === 'file-loaded') {
      void this.confirmLoadWaiter();
    } else if (event.event === 'end-file' && event.reason === 'error') {
      this.rejectLoadWaiter(new Error('mpv could not load the requested media.'));
    }
    this.options.onEvent(event);
  }

  private unlisten(): void {
    for (const unlisten of this.unlisteners.splice(0)) unlisten();
  }

  private waitForFileLoad(expectedPathPrefix: string): Promise<void> {
    this.rejectLoadWaiter(new Error('A newer media load replaced the previous request.'));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.loadWaiter?.timer !== timer) return;
        this.loadWaiter = null;
        reject(new Error('mpv did not finish restoring the episode in time.'));
      }, this.options.loadTimeoutMs);
      this.loadWaiter = { expectedPathPrefix, resolve, reject, timer };
    });
  }

  private async confirmLoadWaiter(): Promise<void> {
    const waiter = this.loadWaiter;
    if (!waiter) return;
    const path = await this.commands.readPath().catch(() => null);
    if (this.loadWaiter !== waiter || !path?.startsWith(waiter.expectedPathPrefix)) return;
    clearTimeout(waiter.timer);
    this.loadWaiter = null;
    waiter.resolve();
  }

  private rejectLoadWaiter(reason: Error): void {
    const waiter = this.loadWaiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.loadWaiter = null;
    waiter.reject(reason);
  }
}
