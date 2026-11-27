import { localNow } from '$lib/room/clock';
import { INVITE_PREFIX, READY_SETTLE_MS, START_LEAD_MS, cleanDisplayName } from '$lib/room/protocol';
import type {
  GuestStatus,
  Participant,
  RoomChannel,
  RoomEvent,
  RoomMedia,
  RoomOutbound,
  RoomRoute,
  RoomState,
  SetTimer
} from '$lib/room/protocol';
import type { RoomHostResult, RoomJoinResult } from '$lib/types';

const PREVIEW_INVITE = `${INVITE_PREFIX}preview-room@euc1-1.relay.n0.iroh.link`;
const PREVIEW_HOST_NAME = 'Preview host';
const SELF_ID = 1;
const LOADING_STEPS = [0.2, 0.6, 0.9];
const PLAY_FOR_MS = 20_000;
const PAUSE_FOR_MS = 3_000;
const SEEK_BY_SECONDS = 60;
const LOOP_AFTER_SECONDS = 600;

type PreviewGuest = { id: number; name: string; route: RoomRoute; joinsAfterMs: number; stepMs: number };

const PREVIEW_GUESTS: PreviewGuest[] = [
  { id: 1, name: 'Alice', route: 'direct', joinsAfterMs: 600, stepMs: 400 },
  { id: 2, name: 'Mika', route: 'relay', joinsAfterMs: 1_400, stepMs: 700 }
];

type Role = 'solo' | 'host' | 'guest';

const defaultSetTimer: SetTimer = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};

export class PreviewRoom {
  private readonly media: RoomMedia;
  private readonly now: () => number;
  private readonly setTimer: SetTimer;
  private readonly timers = new Set<() => void>();
  private role: Role = 'solo';
  private channel: RoomChannel | null = null;
  private guests = new Map<number, PreviewGuest>();
  private state: RoomState | null = null;
  private selfName = '';
  private selfStatus: GuestStatus | null = null;

  constructor(media: RoomMedia, now: () => number = localNow, setTimer: SetTimer = defaultSetTimer) {
    this.media = media;
    this.now = now;
    this.setTimer = setTimer;
  }

  host({ onEvent }: { name: string; onEvent: RoomChannel }): RoomHostResult {
    this.reset('host', onEvent);
    for (const guest of PREVIEW_GUESTS) this.later(guest.joinsAfterMs, () => this.guestJoins(guest));
    return { invite: PREVIEW_INVITE };
  }

  join({ invite, name, onEvent }: { invite: string; name: string; onEvent: RoomChannel }): RoomJoinResult {
    if (!invite.trim().startsWith(INVITE_PREFIX)) throw new Error('This is not a StreamsPlease invite code.');
    this.reset('guest', onEvent);
    this.selfName = cleanDisplayName(name);
    this.state = {
      seq: 1,
      epoch: 1,
      mediaSeq: 1,
      media: this.media,
      playing: false,
      position: 0,
      hostTime: this.now(),
      speed: 1
    };
    this.emit({ type: 'link', status: 'connected' });
    this.emit({ type: 'route', id: 0, route: 'direct' });
    this.emit({ type: 'state', state: this.state });
    this.emitRoster();
    return { selfId: SELF_ID, hostName: PREVIEW_HOST_NAME };
  }

  send({ message }: { message: RoomOutbound }): void {
    if (this.role === 'solo') throw new Error('You are not in a room.');
    if (this.role === 'host') this.hostSent(message);
    else this.guestSent(message);
  }

  remove({ id }: { id: number }): void {
    if (this.role !== 'host') throw new Error('Only the host can do this.');
    if (!this.guests.delete(id)) throw new Error('That guest is no longer in the room.');
    this.emit({ type: 'peerLeft', id, reason: 'removed' });
  }

  lock(_args: { locked: boolean }): void {
    if (this.role !== 'host') throw new Error('Only the host can do this.');
  }

  leave(): void {
    this.reset('solo', null);
  }

  private reset(role: Role, channel: RoomChannel | null): void {
    for (const cancel of this.timers) cancel();
    this.timers.clear();
    this.role = role;
    this.channel = channel;
    this.guests = new Map();
    this.state = null;
    this.selfStatus = null;
  }

  private later(ms: number, run: () => void): void {
    const cancel = this.setTimer(() => {
      this.timers.delete(cancel);
      run();
    }, ms);
    this.timers.add(cancel);
  }

  private emit(event: RoomEvent, afterMs = 0): void {
    const channel = this.channel;
    this.later(afterMs, () => channel?.onmessage(event));
  }

  private hostSent(message: RoomOutbound): void {
    if (message.type !== 'state') return;
    const previous = this.state;
    this.state = message.state;
    if (previous?.epoch === message.state.epoch && previous.mediaSeq === message.state.mediaSeq) return;
    for (const guest of this.guests.values()) this.guestLoads(guest, message.state);
  }

  private guestJoins(guest: PreviewGuest): void {
    this.guests.set(guest.id, guest);
    this.emit({ type: 'peerJoined', id: guest.id, name: guest.name });
    this.emit({ type: 'route', id: guest.id, route: guest.route });
    if (this.state) this.guestLoads(guest, this.state);
  }

  private guestLoads(guest: PreviewGuest, state: RoomState): void {
    const { epoch } = state;
    const report = (afterMs: number, status: GuestStatus) =>
      this.later(afterMs, () => {
        if (this.state?.epoch !== epoch || !this.guests.has(guest.id)) return;
        this.channel?.onmessage({ type: 'peerStatus', id: guest.id, status });
      });
    if (!state.media) {
      report(0, { epoch, phase: 'idle', progress: null });
      return;
    }
    LOADING_STEPS.forEach((progress, step) =>
      report(step * guest.stepMs, { epoch, phase: 'loading', progress })
    );
    report(LOADING_STEPS.length * guest.stepMs, { epoch, phase: 'ready', progress: null });
  }

  private guestSent(message: RoomOutbound): void {
    if (message.type === 'ping') {
      this.emit({ type: 'pong', pingId: message.pingId, sentAt: message.sentAt, hostTime: this.now() });
      return;
    }
    if (message.type !== 'status') return;
    const wasReady = this.selfIsReady();
    this.selfStatus = message.status;
    this.emitRoster();
    if (!wasReady && this.selfIsReady() && !this.state?.playing) {
      this.later(READY_SETTLE_MS, () => this.hostPlays());
    }
  }

  private selfIsReady(): boolean {
    return this.selfStatus?.phase === 'ready' && this.selfStatus.epoch === this.state?.epoch;
  }

  private emitRoster(): void {
    const host: Participant = {
      id: 0,
      name: PREVIEW_HOST_NAME,
      host: true,
      phase: 'ready',
      progress: null,
      blocking: false
    };
    const phase = this.selfStatus?.phase ?? 'loading';
    const self: Participant = {
      id: SELF_ID,
      name: this.selfName,
      host: false,
      phase,
      progress: this.selfStatus?.progress ?? null,
      blocking: phase === 'loading' || (phase === 'ready' && !this.selfIsReady())
    };
    this.emit({ type: 'roster', participants: [host, self] });
  }

  private broadcast(patch: Partial<RoomState>): RoomState | null {
    if (!this.state) return null;
    this.state = { ...this.state, ...patch, seq: this.state.seq + 1 };
    this.emit({ type: 'state', state: this.state });
    return this.state;
  }

  private livePosition(state: RoomState): number {
    if (!state.playing) return state.position;
    const elapsed = Math.max(0, this.now() - state.hostTime) / 1_000;
    return state.position + elapsed * state.speed;
  }

  private hostPlays(): void {
    if (!this.state || this.state.playing || !this.selfIsReady()) return;
    const playing = this.broadcast({ playing: true, hostTime: this.now() + START_LEAD_MS });
    this.later(PLAY_FOR_MS, () => this.hostPauses(playing));
  }

  private hostPauses(playing: RoomState | null): void {
    if (!this.state || this.state !== playing) return;
    const paused = this.broadcast({
      playing: false,
      position: this.livePosition(this.state),
      hostTime: this.now()
    });
    this.later(PAUSE_FOR_MS, () => this.hostSeeks(paused));
  }

  private hostSeeks(paused: RoomState | null): void {
    if (!this.state || this.state !== paused) return;
    const target = paused.position + SEEK_BY_SECONDS;
    this.broadcast({
      epoch: paused.epoch + 1,
      position: target > LOOP_AFTER_SECONDS ? 0 : target,
      hostTime: this.now()
    });
    this.emitRoster();
  }
}
