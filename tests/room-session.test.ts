import assert from 'node:assert/strict';
import test from 'node:test';
import type { Participant, RoomEvent } from '../src/lib/room/protocol.ts';
import { RoomSession } from '../src/lib/room/session.svelte.ts';
import type { RoomSessionTransport } from '../src/lib/room/session.svelte.ts';
import type { RoomHostResult, RoomJoinResult } from '../src/lib/types.ts';
import { FakePlayer, FakeTime, FakeTransport, localPlayback, media, roomState, settle } from './room-fakes.ts';

const INVITE = 'sproom1:abc@relay';
const HOST: Participant = { id: 0, name: 'Host', host: true, phase: 'ready', progress: null, blocking: false };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

class FakeSessionTransport extends FakeTransport implements RoomSessionTransport {
  hosting = deferred<RoomHostResult>();
  joining = deferred<RoomJoinResult>();
  joined: string[] = [];
  left = 0;
  emit: (event: RoomEvent) => void = () => undefined;
  failSend: (reason: unknown) => void = () => undefined;

  host(): Promise<RoomHostResult> {
    this.hosting = deferred();
    return this.hosting.promise;
  }

  join(invite: string, name: string): Promise<RoomJoinResult> {
    this.joined = [invite, name];
    this.joining = deferred();
    return this.joining.promise;
  }

  async leave(): Promise<void> {
    this.left += 1;
  }
}

function setup() {
  const time = new FakeTime();
  const transport = new FakeSessionTransport();
  const player = new FakePlayer(time);
  const session = new RoomSession({
    port: player,
    createTransport: (onEvent, onError) => {
      transport.emit = onEvent;
      transport.failSend = onError;
      return transport;
    },
    now: time.read,
    setTimer: time.setTimer
  });
  player.listener = (local) => session.localChanged(local);
  const names = () => session.roster.map((participant) => participant.name);
  return { time, transport, player, session, names };
}

async function host(room: ReturnType<typeof setup>) {
  const hosting = room.session.host('Sem');
  room.transport.hosting.resolve({ invite: INVITE });
  assert.equal(await hosting, true);
}

async function join(room: ReturnType<typeof setup>) {
  const joining = room.session.join(INVITE, 'Sem');
  room.transport.joining.resolve({ selfId: 1, hostName: 'Host' });
  assert.equal(await joining, true);
}

test('hosting connects, tracks guests and routes, and loads an episode for the room', async () => {
  const room = setup();
  const hosting = room.session.host('Sem');
  assert.equal(room.session.role, 'connecting');
  room.transport.hosting.resolve({ invite: INVITE });
  assert.equal(await hosting, true);
  assert.equal(room.session.role, 'host');
  assert.equal(room.session.invite, INVITE);
  assert.deepEqual(room.names(), ['Sem']);

  room.transport.emit({ type: 'peerJoined', id: 1, name: 'Alice' });
  room.transport.emit({ type: 'route', id: 1, route: 'relay' });
  assert.deepEqual(room.names(), ['Sem', 'Alice']);
  assert.deepEqual(room.session.routes, { 1: 'relay' });

  const request = { ...media(), magnet: ` ${media().magnet} `, day: 'Monday' };
  assert.equal(room.session.load(request, 42), true);
  await settle();
  assert.equal(room.player.calls[0], 'load:01@42');
  assert.deepEqual(room.session.roomState?.media, media());
  assert.equal(room.session.wantsPlay, true);
  assert.deepEqual(room.transport.last('state')?.state.media, media());

  room.session.pause();
  assert.equal(room.session.wantsPlay, false);
  room.transport.emit({ type: 'peerLeft', id: 1, reason: 'left' });
  assert.deepEqual(room.names(), ['Sem']);
  assert.deepEqual(room.session.routes, {});
});

test('hosting adopts the playing episode and refuses media the room would reject', async () => {
  const room = setup();
  await host(room);
  room.session.adopt(media(), localPlayback({ paused: false, position: 100, sampledAt: room.time.now }), 1.25);
  await settle();
  assert.equal(room.session.roomState?.playing, true);
  assert.equal(room.session.roomState?.position, 100);
  assert.equal(room.session.roomState?.speed, 1.25);
  assert.ok(!room.player.calls.some((call) => call.startsWith('load')));

  const { seq } = room.session.roomState!;
  assert.equal(room.session.load({ ...media('02'), slug: 'Not A Slug' }, 0), false);
  assert.equal(room.session.error, 'This episode cannot be shared with the room.');
  assert.equal(room.session.roomState?.seq, seq);
});

test('a guest buffers events until the join resolves, then follows the room', async () => {
  const room = setup();
  const joining = room.session.join(` ${INVITE} `, 'Sem');
  room.transport.emit({ type: 'link', status: 'connected' });
  room.transport.emit({ type: 'state', state: roomState({ position: 42 }) });
  room.transport.emit({ type: 'roster', participants: [HOST] });
  room.transport.emit({ type: 'route', id: 0, route: 'direct' });
  assert.equal(room.session.role, 'connecting');
  assert.deepEqual(room.names(), []);
  assert.deepEqual(room.transport.sent, []);

  room.transport.joining.resolve({ selfId: 1, hostName: 'Host' });
  assert.equal(await joining, true);
  assert.deepEqual(room.transport.joined, [INVITE, 'Sem']);
  assert.equal(room.session.role, 'guest');
  assert.equal(room.session.selfId, 1);
  assert.equal(room.session.hostName, 'Host');
  assert.equal(room.session.roomState?.position, 42);
  assert.deepEqual(room.names(), ['Host']);
  assert.deepEqual(room.session.routes, { 0: 'direct' });
  assert.deepEqual(room.player.calls, ['load:01@42']);
  assert.equal(room.transport.last('status')?.status.phase, 'loading');

  room.transport.emit({ type: 'link', status: 'reconnecting' });
  assert.equal(room.session.link, 'reconnecting');
});

test('a guest that is away loads the room media only after it returns', async () => {
  const room = setup();
  room.session.setAttached(false);
  await join(room);
  room.transport.emit({ type: 'state', state: roomState() });
  await settle();
  assert.deepEqual(room.player.calls, []);
  assert.equal(room.transport.last('status')?.status.phase, 'away');

  room.session.setAttached(true);
  assert.deepEqual(room.player.calls, ['load:01@0']);
});

for (const reason of ['ended', 'removed', 'hostLost', 'failed'] as const) {
  test(`a room closed as ${reason} returns a following guest to solo, paused at the room speed`, async () => {
    const room = setup();
    await join(room);
    room.transport.emit({ type: 'state', state: roomState({ speed: 1.5 }) });
    await settle();

    room.transport.emit({ type: 'closed', reason });
    assert.equal(room.session.role, 'solo');
    assert.equal(room.session.closeReason, reason);
    assert.equal(room.session.roomState, null);
    assert.deepEqual(room.session.roster, []);
    assert.equal(room.transport.left, 1);
    assert.deepEqual(room.player.calls.slice(-2), ['pause', 'speed:1.5']);

    const sent = room.transport.sent.length;
    await room.time.advance(30_000);
    assert.equal(room.transport.sent.length, sent);
  });
}

test('ending a room leaves the host player alone, and a guest in an empty room too', async () => {
  const hosted = setup();
  await host(hosted);
  hosted.session.load(media(), 0);
  await settle();
  const calls = hosted.player.calls.length;
  await hosted.session.leave();
  assert.equal(hosted.session.role, 'solo');
  assert.equal(hosted.transport.left, 1);
  assert.equal(hosted.player.calls.length, calls);

  const joined = setup();
  await join(joined);
  joined.transport.emit({ type: 'state', state: roomState({ media: null }) });
  joined.transport.emit({ type: 'closed', reason: 'ended' });
  await settle();
  assert.deepEqual(joined.player.calls, []);
});

test('leaving while connecting ignores the late result', async () => {
  const room = setup();
  const hosting = room.session.host('Sem');
  const pendingHost = room.transport.hosting;
  await room.session.leave();
  assert.equal(room.session.role, 'solo');
  pendingHost.reject(new Error('The room was left before it was ready.'));
  assert.equal(await hosting, false);
  assert.equal(room.session.error, '');

  const joining = room.session.join(INVITE, 'Sem');
  const pendingJoin = room.transport.joining;
  await room.session.leave();
  pendingJoin.resolve({ selfId: 1, hostName: 'Host' });
  assert.equal(await joining, false);
  assert.equal(room.session.role, 'solo');
  assert.equal(room.session.hostName, '');
  assert.deepEqual(room.transport.sent, []);
});

test('a failed join returns to solo with the reason, and a new attempt clears it', async () => {
  const room = setup();
  const joining = room.session.join(INVITE, 'Sem');
  room.transport.joining.reject(new Error('The room is full.'));
  assert.equal(await joining, false);
  assert.equal(room.session.role, 'solo');
  assert.equal(room.session.error, 'The room is full.');

  void room.session.host('Sem');
  assert.equal(room.session.error, '');
  assert.equal(room.session.role, 'connecting');
});

test('send failures surface as the session error only inside a room', async () => {
  const room = setup();
  room.transport.failSend(new Error('offline'));
  assert.equal(room.session.error, '');
  await host(room);
  room.transport.failSend(new Error('offline'));
  assert.equal(room.session.error, 'offline');
});

test('nothing changes after dispose', async () => {
  const room = setup();
  await host(room);
  room.session.dispose();
  assert.equal(room.session.role, 'solo');
  assert.equal(room.transport.left, 1);

  room.transport.emit({ type: 'peerJoined', id: 1, name: 'Alice' });
  assert.deepEqual(room.session.roster, []);
  assert.equal(await room.session.host('Sem'), false);
  assert.equal(await room.session.join(INVITE, 'Sem'), false);
  assert.equal(room.session.role, 'solo');

  const connecting = setup();
  const joining = connecting.session.join(INVITE, 'Sem');
  const pendingJoin = connecting.transport.joining;
  connecting.session.dispose();
  pendingJoin.resolve({ selfId: 1, hostName: 'Host' });
  assert.equal(await joining, false);
  assert.equal(connecting.session.role, 'solo');
});
