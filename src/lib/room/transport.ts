import { Channel } from '@tauri-apps/api/core';
import { callBackend, isTauri } from '$lib/backend';
import type { BackendCall } from '$lib/backend';
import { parseRoomEvent } from '$lib/room/protocol';
import type { RoomChannel, RoomEvent, RoomOutbound, RoomTransport } from '$lib/room/protocol';
import type { RoomHostResult, RoomJoinResult } from '$lib/types';

export type BackendRoomTransportOptions = {
  call: BackendCall;
  createChannel: () => RoomChannel;
  onEvent: (event: RoomEvent) => void;
  onError?: (reason: unknown) => void;
};

export class BackendRoomTransport implements RoomTransport {
  private readonly options: BackendRoomTransportOptions;
  private channel: RoomChannel | null = null;

  constructor(options: BackendRoomTransportOptions) {
    this.options = options;
  }

  host(name: string): Promise<RoomHostResult> {
    return this.options.call('room_host', { name, onEvent: this.openChannel() });
  }

  join(invite: string, name: string): Promise<RoomJoinResult> {
    return this.options.call('room_join', { invite, name, onEvent: this.openChannel() });
  }

  send(message: RoomOutbound): void {
    if (!this.channel) return;
    this.options.call('room_send', { message }).catch((reason) => this.options.onError?.(reason));
  }

  remove(id: number): Promise<void> {
    return this.options.call('room_remove', { id });
  }

  lock(locked: boolean): Promise<void> {
    return this.options.call('room_lock', { locked });
  }

  leave(): Promise<void> {
    this.channel = null;
    return this.options.call('room_leave');
  }

  private openChannel(): RoomChannel {
    const channel = this.options.createChannel();
    channel.onmessage = (value) => {
      if (this.channel !== channel) return;
      const event = parseRoomEvent(value);
      if (event) this.options.onEvent(event);
    };
    this.channel = channel;
    return channel;
  }
}

function createRoomChannel(): RoomChannel {
  return isTauri() ? new Channel<unknown>() : { onmessage: () => undefined };
}

export function createRoomTransport(
  onEvent: (event: RoomEvent) => void,
  onError?: (reason: unknown) => void
): BackendRoomTransport {
  return new BackendRoomTransport({
    call: callBackend,
    createChannel: createRoomChannel,
    onEvent,
    onError
  });
}
