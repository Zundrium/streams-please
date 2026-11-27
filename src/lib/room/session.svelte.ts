import { untrack } from 'svelte';
import { Generation } from '$lib/async/generation';
import { errorMessage } from '$lib/errors';
import { localNow } from '$lib/room/clock';
import { GuestController } from '$lib/room/guest-controller';
import { HostController } from '$lib/room/host-controller';
import { roomMediaFrom } from '$lib/room/protocol';
import type {
  Participant,
  RoomCloseReason,
  RoomEvent,
  RoomLinkStatus,
  RoomMedia,
  RoomRoute,
  RoomState,
  RoomTransport,
  SetTimer
} from '$lib/room/protocol';
import type { LocalPlayback, PlaybackPort } from '$lib/room/reconcile';
import { createRoomTransport } from '$lib/room/transport';
import type { RoomHostResult, RoomJoinResult } from '$lib/types';

export type RoomRole = 'solo' | 'connecting' | 'host' | 'guest';

export interface RoomSessionTransport extends RoomTransport {
  host(name: string): Promise<RoomHostResult>;
  join(invite: string, name: string): Promise<RoomJoinResult>;
  leave(): Promise<void>;
}

export type RoomSessionOptions = {
  port: PlaybackPort;
  createTransport?: (
    onEvent: (event: RoomEvent) => void,
    onError: (reason: unknown) => void
  ) => RoomSessionTransport;
  now?: () => number;
  setTimer?: SetTimer;
};

const startTimer: SetTimer = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};

export class RoomSession {
  role = $state<RoomRole>('solo');
  invite = $state('');
  hostName = $state('');
  selfId = $state(0);
  roomState = $state.raw<RoomState | null>(null);
  roster = $state.raw<Participant[]>([]);
  routes = $state.raw<Record<number, RoomRoute>>({});
  link = $state<RoomLinkStatus>('connected');
  wantsPlay = $state(false);
  closeReason = $state<RoomCloseReason | null>(null);
  error = $state('');

  private readonly port: PlaybackPort;
  private readonly transport: RoomSessionTransport;
  private readonly now: () => number;
  private readonly setTimer: SetTimer;
  private readonly attempts = new Generation();
  private hostController: HostController | null = null;
  private guestController: GuestController | null = null;
  private pending: RoomEvent[] = [];
  private attached = true;
  private disposed = false;

  constructor(options: RoomSessionOptions) {
    this.port = options.port;
    this.now = options.now ?? localNow;
    this.setTimer = options.setTimer ?? startTimer;
    this.transport = (options.createTransport ?? createRoomTransport)(
      (event) => this.handleEvent(event),
      (reason) => this.handleSendError(reason)
    );
  }

  host = async (name: string): Promise<boolean> => {
    if (this.disposed) return false;
    const attempt = this.connect();
    try {
      const { invite } = await this.transport.host(name);
      if (!this.attempts.isCurrent(attempt)) return false;
      this.invite = invite;
      this.hostController = new HostController({ ...this.controllerOptions(), name });
      this.enter('host');
      return this.role === 'host';
    } catch (reason) {
      return this.fail(attempt, reason);
    }
  };

  join = async (invite: string, name: string): Promise<boolean> => {
    if (this.disposed) return false;
    const attempt = this.connect();
    try {
      const { selfId, hostName } = await this.transport.join(invite.trim(), name);
      if (!this.attempts.isCurrent(attempt)) return false;
      this.selfId = selfId;
      this.hostName = hostName;
      const controller = new GuestController(this.controllerOptions());
      controller.setAttached(this.attached);
      this.guestController = controller;
      this.enter('guest');
      return this.role === 'guest';
    } catch (reason) {
      return this.fail(attempt, reason);
    }
  };

  leave = async (): Promise<void> => {
    this.exit();
    this.closeReason = null;
    this.error = '';
    await this.transport.leave().catch(() => undefined);
  };

  dispose = (): void => {
    void this.leave();
    this.disposed = true;
  };

  adopt = (media: RoomMedia, local: LocalPlayback, speed: number): void => {
    const shared = this.shareable(media);
    if (shared) this.drive(() => this.hostController?.adopt(shared, local, speed));
  };

  load = (media: RoomMedia, startAt: number): boolean => {
    const shared = this.shareable(media);
    if (shared) this.drive(() => this.hostController?.load(shared, startAt));
    return shared !== null;
  };

  play = (): void => this.drive(() => this.hostController?.play());

  pause = (): void => this.drive(() => this.hostController?.pause());

  seek = (target: number): void => this.drive(() => this.hostController?.seek(target));

  setSpeed = (speed: number): void => this.drive(() => this.hostController?.setSpeed(speed));

  localChanged = (local: LocalPlayback): void =>
    this.drive(() => (this.hostController ?? this.guestController)?.localChanged(local));

  setAttached = (attached: boolean): void => {
    this.attached = attached;
    this.drive(() => this.guestController?.setAttached(attached));
  };

  // Port calls read app state, so they must not become dependencies of the caller's effect.
  private drive(run: () => void): void {
    untrack(run);
  }

  private controllerOptions() {
    return {
      transport: this.transport,
      port: this.port,
      now: this.now,
      setTimer: this.setTimer,
      onChange: () => this.sync()
    };
  }

  private connect(): number {
    this.exit();
    this.closeReason = null;
    this.error = '';
    this.role = 'connecting';
    return this.attempts.current;
  }

  private enter(role: 'host' | 'guest'): void {
    this.role = role;
    const pending = this.pending;
    this.pending = [];
    for (const event of pending) this.dispatch(event);
    this.sync();
  }

  private fail(attempt: number, reason: unknown): false {
    if (this.attempts.isCurrent(attempt)) {
      this.exit();
      this.error = errorMessage(reason);
    }
    return false;
  }

  private exit(): void {
    const followed = this.guestController?.roomState ?? null;
    this.attempts.next();
    this.hostController?.dispose();
    this.guestController?.dispose();
    this.hostController = null;
    this.guestController = null;
    this.pending = [];
    this.role = 'solo';
    this.invite = '';
    this.hostName = '';
    this.selfId = 0;
    this.roomState = null;
    this.roster = [];
    this.routes = {};
    this.link = 'connected';
    this.wantsPlay = false;
    if (followed?.media) this.release(followed.speed);
  }

  private release(speed: number): void {
    this.drive(() => {
      void this.port.setPaused(true).catch(() => undefined);
      void this.port.setSpeed(speed).catch(() => undefined);
    });
  }

  private shareable(media: RoomMedia): RoomMedia | null {
    const shared = roomMediaFrom(media);
    this.error = shared ? '' : 'This episode cannot be shared with the room.';
    return shared;
  }

  private sync(): void {
    const host = this.hostController;
    const guest = this.guestController;
    if (host) {
      this.roomState = host.roomState;
      this.roster = host.roster;
      this.wantsPlay = host.wantsPlay;
    } else if (guest) {
      this.roomState = guest.roomState;
      this.roster = guest.roster;
      this.link = guest.link;
    }
  }

  private handleEvent(event: RoomEvent): void {
    if (this.disposed) return;
    if (this.role === 'connecting') this.pending.push(event);
    else if (this.role !== 'solo') this.dispatch(event);
  }

  private handleSendError(reason: unknown): void {
    if (this.hostController || this.guestController) this.error = errorMessage(reason);
  }

  private dispatch(event: RoomEvent): void {
    switch (event.type) {
      case 'closed':
        this.exit();
        this.closeReason = event.reason;
        void this.transport.leave().catch(() => undefined);
        return;
      case 'route':
        this.routes = { ...this.routes, [event.id]: event.route };
        return;
      case 'inviteChanged':
        this.invite = event.invite;
        return;
      case 'peerLeft': {
        const { [event.id]: _left, ...routes } = this.routes;
        this.routes = routes;
        break;
      }
    }
    this.drive(() => (this.hostController ?? this.guestController)?.handleEvent(event));
  }
}
