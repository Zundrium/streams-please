import {
  END_OF_FILE_SECONDS,
  INITIAL_ROOM_STATE,
  READY_SETTLE_MS,
  ROSTER_BROADCAST_INTERVAL_MS,
  START_LEAD_MS,
  STATE_BROADCAST_INTERVAL_MS,
  STATE_HEARTBEAT_PAUSED_MS,
  STATE_HEARTBEAT_PLAYING_MS,
  TICK_MS,
  clampPosition,
  cleanDisplayName,
  isPlaybackSpeed
} from '$lib/room/protocol';
import type {
  GuestStatus,
  Participant,
  RoomEvent,
  RoomMedia,
  RoomState,
  RoomTransport,
  SetTimer
} from '$lib/room/protocol';
import { ReadinessTracker } from '$lib/room/readiness';
import { IDLE_PLAYBACK, Reconciler, expectedPosition, extrapolatedPosition } from '$lib/room/reconcile';
import type { LocalPlayback, PlaybackPort } from '$lib/room/reconcile';

export type HostControllerOptions = {
  transport: RoomTransport;
  port: PlaybackPort;
  now: () => number;
  setTimer: SetTimer;
  name: string;
  onChange?: () => void;
};

type Guest = { name: string; status: GuestStatus | null; bypassed: boolean };
type Intent = 'play' | 'pause';

class Throttle {
  private readonly setTimer: SetTimer;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly send: () => void;
  private cancelTimer: (() => void) | null = null;
  private sentAt = Number.NEGATIVE_INFINITY;

  constructor(setTimer: SetTimer, now: () => number, intervalMs: number, send: () => void) {
    this.setTimer = setTimer;
    this.now = now;
    this.intervalMs = intervalMs;
    this.send = send;
  }

  get lastSentAt(): number {
    return this.sentAt;
  }

  request(): void {
    if (this.cancelTimer) return;
    const wait = this.sentAt + this.intervalMs - this.now();
    if (wait <= 0) this.fire();
    else this.cancelTimer = this.setTimer(() => this.fire(), wait);
  }

  cancel(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private fire(): void {
    this.cancelTimer = null;
    this.sentAt = this.now();
    this.send();
  }
}

export class HostController {
  private readonly options: HostControllerOptions;
  private readonly name: string;
  private readonly reconciler: Reconciler;
  private readonly readiness = new ReadinessTracker();
  private readonly stateBroadcast: Throttle;
  private readonly rosterBroadcast: Throttle;
  private readonly guests = new Map<number, Guest>();
  private state: RoomState = { ...INITIAL_ROOM_STATE };
  private local: LocalPlayback = IDLE_PLAYBACK;
  private self: GuestStatus = { epoch: 0, phase: 'idle', progress: null };
  private intent: Intent = 'pause';
  private participants: Participant[] = [];
  private rosterKey = '';
  private changeKey = '';
  private clearSince: number | null = null;
  private cancelSettle: (() => void) | null = null;
  private cancelTick: (() => void) | null = null;
  private disposed = false;

  constructor(options: HostControllerOptions) {
    this.options = options;
    this.name = cleanDisplayName(options.name);
    this.reconciler = new Reconciler({
      port: options.port,
      now: options.now,
      setTimer: options.setTimer,
      onWake: () => this.refresh(),
      correctDrift: false
    });
    this.stateBroadcast = new Throttle(options.setTimer, options.now, STATE_BROADCAST_INTERVAL_MS, () =>
      options.transport.send({ type: 'state', state: this.state })
    );
    this.rosterBroadcast = new Throttle(options.setTimer, options.now, ROSTER_BROADCAST_INTERVAL_MS, () =>
      options.transport.send({ type: 'roster', participants: this.participants })
    );
    this.state = { ...this.state, hostTime: options.now() };
    this.refresh();
    this.armTick();
  }

  get roomState(): RoomState {
    return this.state;
  }

  get roster(): Participant[] {
    return this.participants;
  }

  get waitingFor(): Participant[] {
    return this.participants.filter((participant) => participant.blocking);
  }

  get wantsPlay(): boolean {
    return this.intent === 'play';
  }

  adopt(media: RoomMedia, local: LocalPlayback, speed: number): void {
    const playing = local.phase === 'ready' && !local.paused;
    this.local = local;
    this.intent = local.paused ? 'pause' : 'play';
    this.commit({
      epoch: this.state.epoch + 1,
      mediaSeq: this.state.mediaSeq + 1,
      media,
      playing,
      position: clampPosition(local.position, local.duration),
      speed: isPlaybackSpeed(speed) ? speed : 1
    });
    this.reconciler.adopt(this.state);
    this.refresh();
  }

  load(media: RoomMedia, startAt: number): void {
    for (const guest of this.guests.values()) guest.bypassed = false;
    this.intent = 'play';
    this.commit({
      epoch: this.state.epoch + 1,
      mediaSeq: this.state.mediaSeq + 1,
      media,
      playing: false,
      position: clampPosition(startAt)
    });
    this.refresh();
  }

  play(): void {
    if (!this.state.media) return;
    this.intent = 'play';
    this.refresh();
  }

  pause(): void {
    this.intent = 'pause';
    if (this.state.playing) this.commit({ playing: false, position: this.playhead() });
    this.refresh();
  }

  seek(target: number): void {
    if (!this.state.media) return;
    this.commit({
      epoch: this.state.epoch + 1,
      playing: false,
      position: clampPosition(target, this.local.duration)
    });
    this.refresh();
  }

  setSpeed(speed: number): void {
    if (!isPlaybackSpeed(speed) || speed === this.state.speed) return;
    const hostTime = Math.max(this.options.now(), this.state.playing ? this.state.hostTime : 0);
    this.commit({ position: this.playhead(), hostTime, speed });
    this.refresh();
  }

  stop(): void {
    if (!this.state.media) return;
    this.intent = 'pause';
    this.commit({
      epoch: this.state.epoch + 1,
      mediaSeq: this.state.mediaSeq + 1,
      media: null,
      playing: false,
      position: 0
    });
    this.refresh();
  }

  playAnyway(): void {
    for (const guest of this.guests.values()) {
      if (this.guestBlocks(guest)) guest.bypassed = true;
    }
    this.refresh();
  }

  localChanged(local: LocalPlayback): void {
    this.local = local;
    this.reconciler.localChanged();
    this.refresh();
  }

  handleEvent(event: RoomEvent): void {
    if (this.disposed) return;
    switch (event.type) {
      case 'peerJoined':
        this.guests.set(event.id, { name: event.name, status: null, bypassed: false });
        break;
      case 'peerLeft':
        this.guests.delete(event.id);
        break;
      case 'peerStatus': {
        const guest = this.guests.get(event.id);
        if (!guest) return;
        guest.status = event.status;
        if (this.reportsReady(guest)) guest.bypassed = false;
        break;
      }
      case 'peerPing':
        this.options.transport.send({
          type: 'pong',
          id: event.id,
          pingId: event.pingId,
          sentAt: event.sentAt,
          hostTime: this.options.now()
        });
        return;
      default:
        return;
    }
    this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    this.reconciler.dispose();
    this.stateBroadcast.cancel();
    this.rosterBroadcast.cancel();
    this.clearSettle();
    this.cancelTick?.();
    this.cancelTick = null;
  }

  private refresh(): void {
    if (this.disposed) return;
    const { state, local } = this;
    this.self = this.readiness.update(state.epoch, {
      attached: true,
      hasMedia: state.media !== null,
      settled: this.reconciler.isSettled(state),
      phase: local.phase,
      seeking: local.seeking,
      downloaded: local.downloaded,
      bufferedAhead: local.bufferedAhead,
      position: local.position,
      duration: local.duration
    });
    this.detectEndOfFile();
    this.gate();
    this.reconciler.run(this.state, local, {
      hostNow: this.options.now(),
      synced: true,
      ready: this.self.phase === 'ready'
    });
    this.publishRoster();
    this.notify();
  }

  private notify(): void {
    const key = `${this.state.seq}:${this.intent}:${this.rosterKey}`;
    if (key === this.changeKey) return;
    this.changeKey = key;
    this.options.onChange?.();
  }

  private commit(patch: Partial<RoomState>): void {
    this.state = { ...this.state, hostTime: this.options.now(), ...patch, seq: this.state.seq + 1 };
    this.stateBroadcast.request();
  }

  private playhead(): number {
    const { state, local } = this;
    const now = this.options.now();
    if (!state.playing) return state.position;
    if (!local.loaded || now < state.hostTime) return expectedPosition(state, now);
    return extrapolatedPosition(local, now, state.speed);
  }

  private reportsReady(guest: Guest): boolean {
    return guest.status?.epoch === this.state.epoch && guest.status.phase === 'ready';
  }

  private guestBlocks(guest: Guest): boolean {
    if (!this.state.media || guest.bypassed || this.reportsReady(guest)) return false;
    if (guest.status?.phase === 'away') return false;
    return !(guest.status?.phase === 'error' && guest.status.epoch === this.state.epoch);
  }

  private hostBlocks(): boolean {
    return this.state.media !== null && this.self.phase !== 'ready';
  }

  private detectEndOfFile(): void {
    const { state, local } = this;
    if (
      !state.playing ||
      !local.paused ||
      local.duration <= 0 ||
      this.options.now() < state.hostTime ||
      !this.reconciler.isSettled(state) ||
      local.position < local.duration - END_OF_FILE_SECONDS
    ) {
      return;
    }
    this.intent = 'pause';
    this.commit({ playing: false, position: clampPosition(local.position, local.duration) });
  }

  private gate(): void {
    const now = this.options.now();
    const blocked = this.hostBlocks() || [...this.guests.values()].some((guest) => this.guestBlocks(guest));
    if (blocked || !this.state.media) {
      this.clearSince = null;
      this.clearSettle();
      if (this.state.playing) this.commit({ playing: false, position: this.playhead() });
      return;
    }
    this.clearSince ??= now;
    if (this.state.playing || this.intent !== 'play') return;
    const wait = this.clearSince + READY_SETTLE_MS - now;
    if (wait <= 0) {
      this.clearSettle();
      this.commit({
        playing: true,
        position: clampPosition(this.local.position, this.local.duration),
        hostTime: now + START_LEAD_MS
      });
    } else if (!this.cancelSettle) {
      this.cancelSettle = this.options.setTimer(() => {
        this.cancelSettle = null;
        this.refresh();
      }, wait);
    }
  }

  private clearSettle(): void {
    this.cancelSettle?.();
    this.cancelSettle = null;
  }

  private publishRoster(): void {
    const hasMedia = this.state.media !== null;
    const participants: Participant[] = [
      {
        id: 0,
        name: this.name,
        host: true,
        phase: this.self.phase,
        progress: this.self.progress,
        blocking: this.hostBlocks()
      }
    ];
    for (const [id, guest] of this.guests) {
      const current = guest.status?.epoch === this.state.epoch || guest.status?.phase === 'away';
      participants.push({
        id,
        name: guest.name,
        host: false,
        phase: guest.status && current ? guest.status.phase : hasMedia ? 'loading' : 'idle',
        progress: guest.status && current ? guest.status.progress : null,
        blocking: this.guestBlocks(guest)
      });
    }
    const key = JSON.stringify(participants);
    if (key === this.rosterKey) return;
    this.rosterKey = key;
    this.participants = participants;
    this.rosterBroadcast.request();
  }

  private armTick(): void {
    this.cancelTick = this.options.setTimer(() => {
      this.heartbeat();
      this.refresh();
      this.armTick();
    }, TICK_MS);
  }

  private heartbeat(): void {
    const { state, local } = this;
    const idle = this.options.now() - this.stateBroadcast.lastSentAt;
    if (!state.playing) {
      if (idle >= STATE_HEARTBEAT_PAUSED_MS) this.stateBroadcast.request();
      return;
    }
    if (idle < STATE_HEARTBEAT_PLAYING_MS || this.options.now() < state.hostTime) return;
    if (local.phase === 'ready' && !local.paused) this.commit({ position: this.playhead() });
    else this.stateBroadcast.request();
  }
}
