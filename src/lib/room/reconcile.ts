import {
  DRIFT_CORRECTION_RATIO,
  DRIFT_HARD_SECONDS,
  DRIFT_OK_SECONDS,
  DRIFT_SETTLED_SECONDS,
  HARD_SEEK_INTERVAL_MS,
  PAUSED_ALIGN_SECONDS,
  SPEED_CORRECTION_INTERVAL_MS,
  TICK_MS,
  clampPosition
} from '$lib/room/protocol';
import type { RoomMedia, RoomState, SetTimer } from '$lib/room/protocol';
import type { Phase } from '$lib/types';

export type LocalPlayback = {
  loaded: boolean;
  phase: Phase;
  paused: boolean;
  position: number;
  sampledAt: number;
  duration: number;
  bufferedAhead: number | null;
  downloaded: boolean;
  seeking: boolean;
};

export const IDLE_PLAYBACK: LocalPlayback = {
  loaded: false,
  phase: 'idle',
  paused: true,
  position: 0,
  sampledAt: 0,
  duration: 0,
  bufferedAhead: null,
  downloaded: false,
  seeking: false
};

export interface PlaybackPort {
  load(media: RoomMedia, position: number): Promise<void>;
  stop(): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  seek(position: number): void;
  setSpeed(speed: number): Promise<void>;
}

export type PlayerAction =
  | { type: 'stop' }
  | { type: 'load'; media: RoomMedia; position: number }
  | { type: 'seek'; position: number; pause: boolean; settle: boolean }
  | { type: 'pause' }
  | { type: 'play'; at: number | null }
  | { type: 'speed'; speed: number };

export type ReconcileMemory = {
  mediaSeq: number | null;
  epoch: number | null;
  alignedPosition: number | null;
  speed: number | null;
  correction: -1 | 0 | 1;
  correctedAt: number;
  hardSeekAt: number;
};

export type ReconcileContext = {
  now: number;
  hostNow: number;
  synced: boolean;
  attached: boolean;
  ready: boolean;
  correctDrift: boolean;
};

export type ReconcileResult = { action: PlayerAction | null; memory: ReconcileMemory };

export const EMPTY_MEMORY: ReconcileMemory = {
  mediaSeq: null,
  epoch: null,
  alignedPosition: null,
  speed: null,
  correction: 0,
  correctedAt: Number.NEGATIVE_INFINITY,
  hardSeekAt: Number.NEGATIVE_INFINITY
};

export function expectedPosition(target: RoomState, hostNow: number): number {
  if (!target.playing) return target.position;
  const elapsed = Math.max(0, hostNow - target.hostTime) / 1000;
  return clampPosition(target.position + elapsed * target.speed);
}

export function extrapolatedPosition(local: LocalPlayback, now: number, speed: number): number {
  if (local.paused || local.phase !== 'ready') return local.position;
  return clampPosition(local.position + (Math.max(0, now - local.sampledAt) / 1000) * speed, local.duration);
}

function correctedSpeed(base: number, correction: number): number {
  return Math.round(base * (1 + DRIFT_CORRECTION_RATIO * correction) * 10_000) / 10_000;
}

function nextCorrection(drift: number, current: -1 | 0 | 1): -1 | 0 | 1 {
  const wanted = drift > 0 ? -1 : 1;
  const threshold = current === wanted ? DRIFT_SETTLED_SECONDS : DRIFT_OK_SECONDS;
  return Math.abs(drift) > threshold ? wanted : 0;
}

export function reconcile(
  target: RoomState,
  local: LocalPlayback,
  previous: ReconcileMemory,
  context: ReconcileContext
): ReconcileResult {
  const memory = { ...previous };
  const act = (action: PlayerAction | null): ReconcileResult => ({ action, memory });
  const speedOrWait = (): ReconcileResult => {
    const speed = correctedSpeed(target.speed, memory.correction);
    if (memory.speed === speed) return act(null);
    memory.speed = speed;
    return act({ type: 'speed', speed });
  };

  if (!context.attached) {
    memory.epoch = null;
    memory.alignedPosition = null;
    memory.correction = 0;
    return act(local.loaded && !local.paused ? { type: 'pause' } : null);
  }

  if (!target.media) {
    if (memory.mediaSeq === null) return act(null);
    return { action: { type: 'stop' }, memory: { ...EMPTY_MEMORY } };
  }

  const expected = expectedPosition(target, context.hostNow);

  if (memory.mediaSeq !== target.mediaSeq) {
    return {
      action: { type: 'load', media: target.media, position: expected },
      memory: {
        ...EMPTY_MEMORY,
        mediaSeq: target.mediaSeq,
        epoch: target.epoch,
        alignedPosition: target.playing ? null : target.position
      }
    };
  }

  if ((local.phase !== 'ready' && local.phase !== 'buffering') || local.duration <= 0) return act(null);

  if (memory.epoch !== target.epoch) {
    memory.epoch = target.epoch;
    memory.alignedPosition = target.playing ? null : target.position;
    memory.correction = 0;
    if (!local.paused || Math.abs(local.position - expected) > PAUSED_ALIGN_SECONDS) {
      return act({ type: 'seek', position: expected, pause: !local.paused, settle: true });
    }
  }

  if (!target.playing) {
    memory.correction = 0;
    if (!local.paused) return act({ type: 'pause' });
    if (!local.seeking && memory.alignedPosition !== target.position) {
      memory.alignedPosition = target.position;
      if (Math.abs(local.position - target.position) > PAUSED_ALIGN_SECONDS) {
        return act({ type: 'seek', position: target.position, pause: false, settle: false });
      }
    }
    return speedOrWait();
  }

  if (local.phase !== 'ready') return act(null);

  if (local.paused) {
    memory.correction = 0;
    const speed = speedOrWait();
    if (speed.action || !context.ready) return speed;
    const scheduled = context.synced && target.hostTime > context.hostNow;
    return act({ type: 'play', at: scheduled ? context.now + (target.hostTime - context.hostNow) : null });
  }

  if (!context.correctDrift || !context.synced || local.seeking) {
    memory.correction = 0;
    return speedOrWait();
  }

  const position = extrapolatedPosition(local, context.now, memory.speed ?? target.speed);
  const drift = position - expected;

  if (Math.abs(drift) > DRIFT_HARD_SECONDS) {
    memory.correction = 0;
    if (context.now - memory.hardSeekAt < HARD_SEEK_INTERVAL_MS) return speedOrWait();
    memory.hardSeekAt = context.now;
    return act({ type: 'seek', position: expected, pause: false, settle: false });
  }

  const correction = nextCorrection(drift, memory.correction);
  if (
    correction !== memory.correction &&
    context.now - memory.correctedAt >= SPEED_CORRECTION_INTERVAL_MS
  ) {
    memory.correction = correction;
    memory.correctedAt = context.now;
  }
  return speedOrWait();
}

export type ReconcilerOptions = {
  port: PlaybackPort;
  now: () => number;
  setTimer: SetTimer;
  onWake: () => void;
  correctDrift: boolean;
};

export type ReconcileClock = { hostNow: number; synced: boolean; ready: boolean };

const SAME_START_MS = 5;

export class Reconciler {
  private readonly options: ReconcilerOptions;
  private memory: ReconcileMemory = { ...EMPTY_MEMORY };
  private attached = true;
  private busy = false;
  private staleUntil = 0;
  private unsettled = false;
  private settleDeadline = 0;
  private startAt: number | null = null;
  private cancelStart: (() => void) | null = null;
  private disposed = false;

  constructor(options: ReconcilerOptions) {
    this.options = options;
  }

  isSettled(target: RoomState): boolean {
    this.expireStale();
    return (
      target.media !== null &&
      this.memory.mediaSeq === target.mediaSeq &&
      this.memory.epoch === target.epoch &&
      !this.unsettled
    );
  }

  adopt(target: RoomState): void {
    this.memory = {
      ...EMPTY_MEMORY,
      mediaSeq: target.mediaSeq,
      epoch: target.epoch,
      alignedPosition: target.position,
      speed: target.speed
    };
  }

  setAttached(attached: boolean, local: LocalPlayback): void {
    if (attached && !this.attached && !local.loaded) this.memory = { ...EMPTY_MEMORY };
    this.attached = attached;
  }

  localChanged(): void {
    this.staleUntil = 0;
    if (!this.busy) this.unsettled = false;
  }

  run(target: RoomState, local: LocalPlayback, clock: ReconcileClock): void {
    if (this.disposed || this.busy) return;
    this.expireStale();
    if (this.staleUntil > 0) return;
    const now = this.options.now();
    const { action, memory } = reconcile(target, local, this.memory, {
      ...clock,
      now,
      attached: this.attached,
      correctDrift: this.options.correctDrift
    });
    this.memory = memory;
    if (action?.type === 'play' && action.at !== null) {
      this.scheduleStart(action.at, now);
      return;
    }
    this.clearStart();
    if (action) this.perform(action, now);
  }

  dispose(): void {
    this.disposed = true;
    this.clearStart();
  }

  private expireStale(): void {
    const now = this.options.now();
    if (now >= this.staleUntil) this.staleUntil = 0;
    if (!this.busy && now >= this.settleDeadline) this.unsettled = false;
  }

  private scheduleStart(at: number, now: number): void {
    if (this.startAt !== null && Math.abs(this.startAt - at) < SAME_START_MS) return;
    this.clearStart();
    this.startAt = at;
    this.cancelStart = this.options.setTimer(() => {
      this.startAt = null;
      this.cancelStart = null;
      this.options.onWake();
    }, Math.max(0, at - now));
  }

  private clearStart(): void {
    this.cancelStart?.();
    this.cancelStart = null;
    this.startAt = null;
  }

  private perform(action: PlayerAction, now: number): void {
    const { port } = this.options;
    if (action.type !== 'speed') this.staleUntil = now + TICK_MS;
    switch (action.type) {
      case 'stop':
        return this.track(() => port.stop(), true);
      case 'load':
        return this.track(() => port.load(action.media, action.position), true);
      case 'seek':
        return this.track(async () => {
          if (action.pause) await port.setPaused(true);
          port.seek(action.position);
        }, action.settle);
      case 'pause':
        return this.track(() => port.setPaused(true), false);
      case 'play':
        return this.track(() => port.setPaused(false), false);
      case 'speed':
        return this.track(() => port.setSpeed(action.speed), false);
    }
  }

  private track(start: () => Promise<void>, unsettles: boolean): void {
    this.busy = true;
    this.unsettled ||= unsettles;
    const finish = () => {
      this.busy = false;
      if (this.disposed) return;
      if (unsettles) this.settleDeadline = this.options.now() + TICK_MS;
      this.options.onWake();
    };
    let operation: Promise<void>;
    try {
      operation = start();
    } catch (reason) {
      operation = Promise.reject(reason);
    }
    operation.then(finish, finish);
  }
}
