import { HostClock } from '$lib/room/clock';
import {
  CLOCK_BURST_INTERVAL_MS,
  CLOCK_BURST_SAMPLES,
  CLOCK_SAMPLE_INTERVAL_MS,
  STATUS_HEARTBEAT_MS,
  STATUS_PROGRESS_INTERVAL_MS,
  TICK_MS
} from '$lib/room/protocol';
import type {
  GuestStatus,
  Participant,
  RoomEvent,
  RoomLinkStatus,
  RoomState,
  RoomTransport,
  SetTimer
} from '$lib/room/protocol';
import { ReadinessTracker } from '$lib/room/readiness';
import { IDLE_PLAYBACK, Reconciler } from '$lib/room/reconcile';
import type { LocalPlayback, PlaybackPort } from '$lib/room/reconcile';

export type GuestControllerOptions = {
  transport: RoomTransport;
  port: PlaybackPort;
  now: () => number;
  setTimer: SetTimer;
  onChange?: () => void;
};

const MAX_PENDING_PINGS = 8;

export class GuestController {
  private readonly options: GuestControllerOptions;
  private readonly reconciler: Reconciler;
  private readonly readiness = new ReadinessTracker();
  private readonly clock = new HostClock();
  private readonly pings = new Map<number, number>();
  private state: RoomState | null = null;
  private lastSeq = -1;
  private participants: Participant[] = [];
  private linkStatus: RoomLinkStatus = 'connected';
  private local: LocalPlayback = IDLE_PLAYBACK;
  private attached = true;
  private reported: GuestStatus | null = null;
  private reportedAt = Number.NEGATIVE_INFINITY;
  private nextPingId = 0;
  private burstLeft = CLOCK_BURST_SAMPLES;
  private cancelPing: (() => void) | null = null;
  private cancelTick: (() => void) | null = null;
  private disposed = false;

  constructor(options: GuestControllerOptions) {
    this.options = options;
    this.reconciler = new Reconciler({
      port: options.port,
      now: options.now,
      setTimer: options.setTimer,
      onWake: () => this.refresh(),
      correctDrift: true
    });
    this.ping();
    this.armTick();
  }

  get roomState(): RoomState | null {
    return this.state;
  }

  get roster(): Participant[] {
    return this.participants;
  }

  get link(): RoomLinkStatus {
    return this.linkStatus;
  }

  localChanged(local: LocalPlayback): void {
    this.local = local;
    this.reconciler.localChanged();
    this.refresh();
  }

  setAttached(attached: boolean): void {
    if (attached === this.attached) return;
    this.attached = attached;
    this.reconciler.setAttached(attached, this.local);
    this.refresh();
  }

  handleEvent(event: RoomEvent): void {
    if (this.disposed) return;
    switch (event.type) {
      case 'state':
        if (event.state.seq <= this.lastSeq) return;
        this.lastSeq = event.state.seq;
        this.state = event.state;
        this.refresh();
        break;
      case 'roster':
        this.participants = event.participants;
        break;
      case 'pong':
        this.acceptPong(event.pingId, event.hostTime);
        return;
      case 'link':
        if (event.status === this.linkStatus) return;
        this.linkStatus = event.status;
        if (event.status === 'connected') this.resetLink();
        break;
      default:
        return;
    }
    this.options.onChange?.();
  }

  dispose(): void {
    this.disposed = true;
    this.reconciler.dispose();
    this.cancelPing?.();
    this.cancelTick?.();
    this.cancelPing = null;
    this.cancelTick = null;
  }

  private refresh(): void {
    const { state, local } = this;
    if (this.disposed || !state) return;
    const status = this.readiness.update(state.epoch, {
      attached: this.attached,
      hasMedia: state.media !== null,
      settled: this.reconciler.isSettled(state),
      phase: local.phase,
      seeking: local.seeking,
      downloaded: local.downloaded,
      bufferedAhead: local.bufferedAhead,
      position: local.position,
      duration: local.duration
    });
    this.reconciler.run(state, local, {
      hostNow: this.clock.hostNow(this.options.now()),
      synced: this.clock.synced,
      ready: status.phase === 'ready'
    });
    this.report(status);
  }

  private report(status: GuestStatus): void {
    const now = this.options.now();
    const last = this.reported;
    const sinceLast = now - this.reportedAt;
    const changed = !last || last.epoch !== status.epoch || last.phase !== status.phase;
    const progressed = last?.progress !== status.progress && sinceLast >= STATUS_PROGRESS_INTERVAL_MS;
    if (!changed && !progressed && sinceLast < STATUS_HEARTBEAT_MS) return;
    this.reported = status;
    this.reportedAt = now;
    this.options.transport.send({ type: 'status', status });
  }

  private resetLink(): void {
    this.lastSeq = -1;
    this.reported = null;
    this.clock.reset();
    this.pings.clear();
    this.burstLeft = CLOCK_BURST_SAMPLES;
    this.cancelPing?.();
    this.ping();
  }

  private ping(): void {
    const sentAt = this.options.now();
    const pingId = this.nextPingId++;
    this.pings.set(pingId, sentAt);
    if (this.pings.size > MAX_PENDING_PINGS) this.pings.delete(this.pings.keys().next().value!);
    this.options.transport.send({ type: 'ping', pingId, sentAt });
    this.burstLeft = Math.max(0, this.burstLeft - 1);
    this.cancelPing = this.options.setTimer(
      () => this.ping(),
      this.burstLeft > 0 ? CLOCK_BURST_INTERVAL_MS : CLOCK_SAMPLE_INTERVAL_MS
    );
  }

  private acceptPong(pingId: number, hostTime: number): void {
    const sentAt = this.pings.get(pingId);
    if (sentAt === undefined) return;
    this.pings.delete(pingId);
    this.clock.addSample(sentAt, hostTime, this.options.now());
    this.refresh();
  }

  private armTick(): void {
    this.cancelTick = this.options.setTimer(() => {
      this.refresh();
      this.armTick();
    }, TICK_MS);
  }
}
