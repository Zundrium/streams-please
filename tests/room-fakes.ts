import type { RoomMedia, RoomOutbound, RoomState, RoomTransport, SetTimer } from '../src/lib/room/protocol.ts';
import { IDLE_PLAYBACK } from '../src/lib/room/reconcile.ts';
import type { LocalPlayback, PlaybackPort } from '../src/lib/room/reconcile.ts';

export const MAGNET = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel';

export function media(episode = '01'): RoomMedia {
  return {
    magnet: MAGNET,
    title: 'Sintel',
    episode,
    slug: 'sintel',
    anilistId: 7,
    imageUrl: 'https://s4.anilist.co/sintel.jpg',
    quality: '1080'
  };
}

export function roomState(patch: Partial<RoomState> = {}): RoomState {
  return {
    seq: 1,
    epoch: 1,
    mediaSeq: 1,
    media: media(),
    playing: false,
    position: 0,
    hostTime: 0,
    speed: 1,
    ...patch
  };
}

export function localPlayback(patch: Partial<LocalPlayback> = {}): LocalPlayback {
  return {
    loaded: true,
    phase: 'ready',
    paused: true,
    position: 0,
    sampledAt: 0,
    duration: 1400,
    bufferedAhead: null,
    downloaded: true,
    seeking: false,
    ...patch
  };
}

export async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

type Timer = { at: number; callback: () => void };

export class FakeTime {
  now = 1_000_000;
  private timers: Timer[] = [];

  readonly read = (): number => this.now;

  readonly setTimer: SetTimer = (callback, ms) => {
    const timer = { at: this.now + Math.max(0, ms), callback };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((other) => other !== timer);
    };
  };

  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    await settle();
    for (;;) {
      const next = this.timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.timers = this.timers.filter((timer) => timer !== next);
      this.now = Math.max(this.now, next.at);
      next.callback();
      await settle();
    }
    this.now = end;
  }
}

export class FakeTransport implements RoomTransport {
  sent: RoomOutbound[] = [];

  send(message: RoomOutbound): void {
    this.sent.push(message);
  }

  of<T extends RoomOutbound['type']>(type: T): Extract<RoomOutbound, { type: T }>[] {
    return this.sent.filter((message): message is Extract<RoomOutbound, { type: T }> => message.type === type);
  }

  last<T extends RoomOutbound['type']>(type: T): Extract<RoomOutbound, { type: T }> | undefined {
    return this.of(type).at(-1);
  }
}

export class FakePlayer implements PlaybackPort {
  calls: string[] = [];
  local: LocalPlayback = IDLE_PLAYBACK;
  listener: (local: LocalPlayback) => void = () => undefined;
  loadGate: Promise<void> | null = null;
  private readonly time: FakeTime;

  constructor(time: FakeTime) {
    this.time = time;
  }

  set(patch: Partial<LocalPlayback>): void {
    this.local = { ...this.local, ...patch, sampledAt: this.time.now };
    const snapshot = this.local;
    setImmediate(() => this.listener(snapshot));
  }

  ready(patch: Partial<LocalPlayback> = {}): void {
    this.set({ phase: 'ready', duration: 1400, downloaded: true, ...patch });
  }

  async load(item: RoomMedia, position: number): Promise<void> {
    this.calls.push(`load:${item.episode}@${position}`);
    this.set({ ...IDLE_PLAYBACK, loaded: true, phase: 'connecting', position });
    if (this.loadGate) await this.loadGate;
  }

  async stop(): Promise<void> {
    this.calls.push('stop');
    this.set(IDLE_PLAYBACK);
  }

  async setPaused(paused: boolean): Promise<void> {
    this.calls.push(paused ? 'pause' : 'play');
    this.set({ paused });
  }

  seek(position: number): void {
    this.calls.push(`seek:${position}`);
    this.set({ position });
  }

  async setSpeed(speed: number): Promise<void> {
    this.calls.push(`speed:${speed}`);
  }
}
