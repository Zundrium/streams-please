import assert from 'node:assert/strict';
import test from 'node:test';
import { callPreviewBackend } from '../src/lib/backend/preview.ts';
import { PreviewRoom } from '../src/lib/backend/preview-room.ts';
import type { BackendCall } from '../src/lib/backend/commands.ts';
import { parseRoomEvent } from '../src/lib/room/protocol.ts';
import type { RoomChannel, RoomEvent } from '../src/lib/room/protocol.ts';
import { BackendRoomTransport } from '../src/lib/room/transport.ts';
import { FakeTime, media, roomState, settle } from './room-fakes.ts';

type Call = { name: string; args: unknown };

function setupTransport(fail = false) {
  const calls: Call[] = [];
  const channels: RoomChannel[] = [];
  const events: RoomEvent[] = [];
  const errors: unknown[] = [];
  const call = (async (name: string, args?: unknown) => {
    calls.push({ name, args });
    if (fail) throw new Error('offline');
    if (name === 'room_host') return { invite: 'sproom1:abc@relay' };
    if (name === 'room_join') return { selfId: 1, hostName: 'Host' };
    return undefined;
  }) as BackendCall;
  const transport = new BackendRoomTransport({
    call,
    createChannel: () => {
      const channel: RoomChannel = { onmessage: () => undefined };
      channels.push(channel);
      return channel;
    },
    onEvent: (event) => events.push(event),
    onError: (reason) => errors.push(reason)
  });
  return { transport, calls, channels, events, errors };
}

test('the transport narrows channel events and drops malformed ones', async () => {
  const { transport, calls, channels, events } = setupTransport();

  assert.deepEqual(await transport.host('Sem'), { invite: 'sproom1:abc@relay' });
  channels[0].onmessage({ type: 'peerJoined', id: 1, name: 'Alice' });
  channels[0].onmessage({ type: 'peerJoined', id: 1, name: 'Alice', admin: true });
  channels[0].onmessage({ type: 'peerJoined', id: 0, name: 'Alice' });
  channels[0].onmessage('closed');

  assert.deepEqual(events, [{ type: 'peerJoined', id: 1, name: 'Alice' }]);
  assert.deepEqual(calls[0], { name: 'room_host', args: { name: 'Sem', onEvent: channels[0] } });
});

test('the transport ignores a channel that a newer room replaced', async () => {
  const { transport, channels, events } = setupTransport();
  await transport.host('Sem');
  await transport.join('sproom1:abc@relay', 'Sem');

  channels[0].onmessage({ type: 'closed', reason: 'ended' });
  channels[1].onmessage({ type: 'link', status: 'connected' });
  await transport.leave();
  channels[1].onmessage({ type: 'closed', reason: 'hostLost' });

  assert.deepEqual(events, [{ type: 'link', status: 'connected' }]);
});

test('the transport sends only inside a room and reports failures', async () => {
  const idle = setupTransport();
  idle.transport.send({ type: 'ping', pingId: 1, sentAt: 5 });
  assert.deepEqual(idle.calls, []);

  const failing = setupTransport(true);
  await assert.rejects(failing.transport.host('Sem'));
  failing.transport.send({ type: 'ping', pingId: 1, sentAt: 5 });
  await settle();

  assert.deepEqual(failing.calls.at(-1), {
    name: 'room_send',
    args: { message: { type: 'ping', pingId: 1, sentAt: 5 } }
  });
  assert.equal(failing.errors.length, 1);
});

function setupPreview() {
  const time = new FakeTime();
  const room = new PreviewRoom(media(), time.read, time.setTimer);
  const events: RoomEvent[] = [];
  const channel: RoomChannel = {
    onmessage: (value) => {
      const event = parseRoomEvent(value);
      assert.ok(event, `the preview emitted an invalid event: ${JSON.stringify(value)}`);
      events.push(event);
    }
  };
  const ofType = <T extends RoomEvent['type']>(type: T) =>
    events.filter((event): event is Extract<RoomEvent, { type: T }> => event.type === type);
  return { time, room, events, channel, ofType };
}

test('the preview host room gains guests that load every new epoch', async () => {
  const { time, room, channel, ofType } = setupPreview();

  assert.match(room.host({ name: 'Sem', onEvent: channel }).invite, /^sproom1:/);
  await time.advance(2_000);
  assert.deepEqual(
    ofType('peerJoined').map((event) => event.name),
    ['Alice', 'Mika']
  );

  room.send({ message: { type: 'state', state: roomState({ epoch: 4 }) } });
  await time.advance(5_000);
  const statuses = ofType('peerStatus');
  for (const id of [1, 2]) {
    const phases = statuses.filter((event) => event.id === id).map((event) => event.status.phase);
    assert.equal(phases[0], 'loading');
    assert.equal(phases.at(-1), 'ready');
  }
  assert.ok(statuses.every((event) => event.status.epoch === 4));

  room.remove({ id: 2 });
  await time.advance(0);
  assert.deepEqual(ofType('peerLeft'), [{ type: 'peerLeft', id: 2, reason: 'removed' }]);
  assert.throws(() => room.remove({ id: 2 }));
});

test('the preview guest room starts once the guest is ready, then pauses and seeks', async () => {
  const { time, room, channel, ofType } = setupPreview();

  assert.throws(() => room.join({ invite: 'nope', name: 'Sem', onEvent: channel }));
  assert.deepEqual(room.join({ invite: 'sproom1:abc@relay', name: ' Sem ', onEvent: channel }), {
    selfId: 1,
    hostName: 'Preview host'
  });
  await time.advance(0);
  assert.equal(ofType('state')[0].state.playing, false);
  assert.equal(ofType('roster')[0].participants[1].name, 'Sem');

  room.send({ message: { type: 'ping', pingId: 3, sentAt: time.now } });
  room.send({ message: { type: 'status', status: { epoch: 1, phase: 'ready', progress: null } } });
  await time.advance(1_000);
  const started = ofType('state').at(-1)!.state;
  assert.equal(ofType('pong')[0].pingId, 3);
  assert.equal(started.playing, true);
  assert.ok(started.hostTime > time.now - 1_000);

  await time.advance(30_000);
  const sought = ofType('state').at(-1)!.state;
  assert.equal(sought.playing, false);
  assert.equal(sought.epoch, 2);
  assert.ok(sought.position > 60);

  room.leave();
  const count = ofType('state').length;
  await time.advance(60_000);
  assert.equal(ofType('state').length, count);
  assert.throws(() => room.send({ message: { type: 'ping', pingId: 4, sentAt: time.now } }));
});

test('the browser preview implements every room command', async () => {
  const channel: RoomChannel = { onmessage: () => undefined };
  const { invite } = await callPreviewBackend('room_host', { name: 'Sem', onEvent: channel });
  assert.match(invite, /^sproom1:/);
  await callPreviewBackend('room_lock', { locked: true });
  await assert.rejects(callPreviewBackend('room_remove', { id: 9 }));
  await callPreviewBackend('room_leave');
  await assert.rejects(callPreviewBackend('room_send', { message: { type: 'ping', pingId: 1, sentAt: 1 } }));
});
