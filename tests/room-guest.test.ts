import assert from 'node:assert/strict';
import test from 'node:test';
import { GuestController } from '../src/lib/room/guest-controller.ts';
import type { RoomState } from '../src/lib/room/protocol.ts';
import { FakePlayer, FakeTime, FakeTransport, media, roomState, settle } from './room-fakes.ts';

const HOST_OFFSET = 5_000;

function setup() {
  const time = new FakeTime();
  const transport = new FakeTransport();
  const player = new FakePlayer(time);
  const guest = new GuestController({
    transport,
    port: player,
    now: time.read,
    setTimer: time.setTimer
  });
  player.listener = (local) => guest.localChanged(local);
  const hostNow = () => time.now + HOST_OFFSET;
  const pong = () => {
    const ping = transport.last('ping');
    assert.ok(ping);
    guest.handleEvent({ type: 'pong', pingId: ping.pingId, sentAt: ping.sentAt, hostTime: hostNow() });
  };
  const state = (patch: Partial<RoomState>) => guest.handleEvent({ type: 'state', state: roomState(patch) });
  return { time, transport, player, guest, hostNow, pong, state };
}

async function follow(room: ReturnType<typeof setup>) {
  room.pong();
  room.state({ seq: 1, position: 42 });
  await settle();
  room.player.ready({ position: 42 });
  await settle();
}

test('a guest loads the room media, reports its phase, and starts at the host time', async () => {
  const room = setup();
  room.pong();
  room.state({ seq: 1, position: 42 });
  await settle();
  assert.deepEqual(room.player.calls, ['load:01@42']);
  assert.deepEqual(room.transport.last('status')?.status, { epoch: 1, phase: 'loading', progress: null });

  room.player.ready({ position: 42 });
  await settle();
  assert.deepEqual(room.transport.last('status')?.status, { epoch: 1, phase: 'ready', progress: null });

  room.state({ seq: 2, playing: true, position: 42, hostTime: room.hostNow() + 500 });
  await room.time.advance(499);
  assert.ok(!room.player.calls.includes('play'));
  await room.time.advance(1);
  assert.equal(room.player.calls.at(-1), 'play');
});

test('a state with a stale sequence number is ignored', async () => {
  const room = setup();
  await follow(room);
  room.state({ seq: 5, position: 42 });
  room.state({ seq: 4, playing: true, position: 42, hostTime: room.hostNow() });
  room.state({ seq: 5, playing: true, position: 42, hostTime: room.hostNow() });
  await room.time.advance(1_000);
  assert.equal(room.guest.roomState?.seq, 5);
  assert.equal(room.guest.roomState?.playing, false);
  assert.ok(!room.player.calls.includes('play'));
});

test('a scheduled start is cancelled by a newer state', async () => {
  const room = setup();
  await follow(room);
  room.state({ seq: 2, playing: true, position: 42, hostTime: room.hostNow() + 500 });
  await room.time.advance(200);
  room.state({ seq: 3, position: 42 });
  await room.time.advance(2_000);
  assert.ok(!room.player.calls.includes('play'));
});

test('status is sent on change, as a heartbeat, and with throttled progress', async () => {
  const room = setup();
  room.pong();
  room.state({ seq: 1, position: 42 });
  await settle();
  room.player.ready({ position: 42, downloaded: false, bufferedAhead: 1 });
  await room.time.advance(1_000);
  assert.deepEqual(room.transport.last('status')?.status, { epoch: 1, phase: 'loading', progress: 0.1 });

  const sent = room.transport.of('status').length;
  room.player.set({ bufferedAhead: 2 });
  room.player.set({ bufferedAhead: 3 });
  await settle();
  assert.equal(room.transport.of('status').length, sent);
  await room.time.advance(500);
  room.player.set({ bufferedAhead: 4 });
  await settle();
  assert.deepEqual(room.transport.last('status')?.status, { epoch: 1, phase: 'loading', progress: 0.4 });

  room.player.set({ bufferedAhead: 12 });
  await settle();
  assert.equal(room.transport.last('status')?.status.phase, 'ready');
  const ready = room.transport.of('status').length;
  await room.time.advance(1_900);
  assert.equal(room.transport.of('status').length, ready);
  await room.time.advance(1_100);
  assert.equal(room.transport.of('status').length, ready + 1);
});

test('a detached guest is away and resyncs when it attaches again', async () => {
  const room = setup();
  await follow(room);
  room.state({ seq: 2, playing: true, position: 42, hostTime: room.hostNow() });
  await settle();
  assert.equal(room.player.calls.at(-1), 'play');

  room.guest.setAttached(false);
  await settle();
  assert.equal(room.player.calls.at(-1), 'pause');
  assert.equal(room.transport.last('status')?.status.phase, 'away');

  room.state({ seq: 3, mediaSeq: 2, epoch: 2, media: media('02'), position: 0 });
  await room.time.advance(2_000);
  assert.equal(room.player.calls.at(-1), 'pause');

  room.guest.setAttached(true);
  await settle();
  assert.equal(room.player.calls.at(-1), 'load:02@0');
  assert.deepEqual(room.transport.last('status')?.status, { epoch: 2, phase: 'loading', progress: null });
});

test('a guest that returns to the same episode seeks to the live position', async () => {
  const room = setup();
  await follow(room);
  room.state({ seq: 2, playing: true, position: 42, hostTime: room.hostNow() });
  await settle();
  room.guest.setAttached(false);
  await room.time.advance(10_000);
  room.pong();
  room.guest.setAttached(true);
  await settle();
  const seek = room.player.calls.findLast((call) => call !== 'play') ?? '';
  assert.ok(seek.startsWith('seek:'), seek);
  assert.ok(Math.abs(Number(seek.slice(5)) - 52) < 0.01, seek);
});

test('the host clock is sampled in a burst and then slowly', async () => {
  const room = setup();
  assert.equal(room.transport.of('ping').length, 1);
  await room.time.advance(800);
  assert.equal(room.transport.of('ping').length, 5);
  await room.time.advance(9_000);
  assert.equal(room.transport.of('ping').length, 5);
  await room.time.advance(1_000);
  assert.equal(room.transport.of('ping').length, 6);
  room.guest.handleEvent({ type: 'pong', pingId: 999, sentAt: 0, hostTime: 1 });
  assert.equal(room.guest.link, 'connected');
});

test('a reconnect resets the sequence, the clock samples, and the reported status', async () => {
  const room = setup();
  await follow(room);
  room.state({ seq: 9, position: 42 });
  await room.time.advance(1_000);
  const pings = room.transport.of('ping').length;
  const statuses = room.transport.of('status').length;

  room.guest.handleEvent({ type: 'link', status: 'reconnecting' });
  assert.equal(room.guest.link, 'reconnecting');
  room.guest.handleEvent({ type: 'link', status: 'connected' });
  assert.equal(room.transport.of('ping').length, pings + 1);

  room.state({ seq: 2, position: 42 });
  await settle();
  assert.equal(room.guest.roomState?.seq, 2);
  assert.equal(room.transport.of('status').length, statuses + 1);
  assert.deepEqual(room.player.calls.filter((call) => call.startsWith('load')), ['load:01@42']);
});

test('rosters are kept for the UI and a disposed guest stays silent', async () => {
  const room = setup();
  const participants = [{ id: 0, name: 'Sem', host: true, phase: 'ready' as const, progress: null, blocking: false }];
  room.guest.handleEvent({ type: 'roster', participants });
  assert.deepEqual(room.guest.roster, participants);
  room.guest.dispose();
  const sent = room.transport.sent.length;
  room.state({ seq: 1 });
  await room.time.advance(5_000);
  assert.equal(room.transport.sent.length, sent);
  assert.deepEqual(room.player.calls, []);
});
