import assert from 'node:assert/strict';
import test from 'node:test';
import { HostController } from '../src/lib/room/host-controller.ts';
import type { ParticipantPhase } from '../src/lib/room/protocol.ts';
import { FakePlayer, FakeTime, FakeTransport, localPlayback, media, settle } from './room-fakes.ts';

function setup() {
  const time = new FakeTime();
  const transport = new FakeTransport();
  const player = new FakePlayer(time);
  let changes = 0;
  const host = new HostController({
    transport,
    port: player,
    now: time.read,
    setTimer: time.setTimer,
    name: ' Sem ',
    onChange: () => (changes += 1)
  });
  player.listener = (local) => host.localChanged(local);
  const join = (id: number, name: string) => host.handleEvent({ type: 'peerJoined', id, name });
  const status = (id: number, epoch: number, phase: ParticipantPhase, progress: number | null = null) =>
    host.handleEvent({ type: 'peerStatus', id, status: { epoch, phase, progress } });
  return { time, transport, player, host, join, status, changes: () => changes };
}

async function loadHost(room: ReturnType<typeof setup>, startAt = 42) {
  room.host.load(media(), startAt);
  await settle();
  room.player.ready({ position: startAt });
  await settle();
}

async function openRoom(room: ReturnType<typeof setup>, startAt = 42) {
  await loadHost(room, startAt);
  await room.time.advance(300);
  await room.time.advance(500);
  assert.equal(room.host.roomState.playing, true);
  assert.equal(room.player.local.paused, false);
}

test('a load waits for every guest and then schedules a shared start', async () => {
  const room = setup();
  room.join(1, 'Alice');
  await loadHost(room);
  assert.deepEqual(room.player.calls, ['load:01@42', 'speed:1']);
  assert.deepEqual(
    { ...room.host.roomState, hostTime: 0, seq: 0 },
    { seq: 0, epoch: 1, mediaSeq: 1, media: media(), playing: false, position: 42, hostTime: 0, speed: 1 }
  );

  room.status(1, 1, 'loading', 0.4);
  await room.time.advance(1_000);
  assert.equal(room.host.roomState.playing, false);
  assert.deepEqual(room.host.waitingFor.map((participant) => participant.name), ['Alice']);
  assert.deepEqual(room.transport.last('roster')?.participants, [
    { id: 0, name: 'Sem', host: true, phase: 'ready', progress: null, blocking: false },
    { id: 1, name: 'Alice', host: false, phase: 'loading', progress: 0.4, blocking: true }
  ]);

  room.status(1, 1, 'ready');
  await room.time.advance(299);
  assert.equal(room.host.roomState.playing, false);
  await room.time.advance(1);
  const opened = room.transport.last('state')?.state;
  assert.equal(opened?.playing, true);
  assert.equal(opened?.position, 42);
  assert.equal(opened?.hostTime, room.time.now + 500);
  assert.ok(!room.player.calls.includes('play'));

  await room.time.advance(500);
  assert.equal(room.player.calls.at(-1), 'play');
  assert.deepEqual(room.host.waitingFor, []);
});

test('a stalled guest holds the room and it resumes by itself', async () => {
  const room = setup();
  room.join(1, 'Alice');
  await loadHost(room);
  room.status(1, 1, 'ready');
  await room.time.advance(800);
  await settle();

  room.player.set({ position: 60 });
  await settle();
  room.status(1, 1, 'loading', 0);
  await settle();
  assert.equal(room.host.roomState.playing, false);
  assert.equal(room.host.roomState.position, 60);
  assert.equal(room.host.wantsPlay, true);
  assert.equal(room.player.calls.at(-1), 'pause');

  room.status(1, 1, 'ready');
  await room.time.advance(300);
  assert.equal(room.host.roomState.playing, true);
  await room.time.advance(500);
  assert.equal(room.player.calls.at(-1), 'play');
});

test('a late joiner holds a playing room until it is ready', async () => {
  const room = setup();
  await openRoom(room);
  room.join(2, 'Bob');
  await settle();
  assert.equal(room.host.roomState.playing, false);
  assert.deepEqual(room.host.waitingFor.map((participant) => participant.id), [2]);

  room.status(2, 0, 'ready');
  await room.time.advance(1_000);
  assert.equal(room.host.roomState.playing, false);

  room.status(2, room.host.roomState.epoch, 'ready');
  await room.time.advance(300);
  assert.equal(room.host.roomState.playing, true);
});

test('a blocking guest that leaves, is away, or fails does not hold the room', async () => {
  for (const release of ['leave', 'away', 'error'] as const) {
    const room = setup();
    room.join(1, 'Alice');
    await loadHost(room);
    await room.time.advance(1_000);
    assert.equal(room.host.roomState.playing, false, release);

    if (release === 'leave') room.host.handleEvent({ type: 'peerLeft', id: 1, reason: 'left' });
    else room.status(1, 1, release);
    await room.time.advance(300);
    assert.equal(room.host.roomState.playing, true, release);
  }
});

test('play anyway bypasses blocking guests until they report ready or a new load starts', async () => {
  const room = setup();
  room.join(1, 'Alice');
  await loadHost(room);
  room.status(1, 1, 'loading', 0.1);
  room.host.playAnyway();
  await room.time.advance(300);
  assert.equal(room.host.roomState.playing, true);
  assert.equal(room.host.roster[1].blocking, false);
  await room.time.advance(500);

  room.status(1, 1, 'ready');
  room.status(1, 1, 'loading', 0.2);
  await settle();
  assert.equal(room.host.roomState.playing, false);
  assert.equal(room.host.roster[1].blocking, true);

  room.host.playAnyway();
  await room.time.advance(300);
  assert.equal(room.host.roomState.playing, true);
  room.host.load(media('02'), 0);
  await settle();
  assert.equal(room.host.roster[1].blocking, true);
});

test('a seek starts a new epoch and ignores readiness from the old one', async () => {
  const room = setup();
  room.join(1, 'Alice');
  await loadHost(room);
  room.status(1, 1, 'ready');
  await room.time.advance(800);
  await settle();

  room.host.seek(300);
  await settle();
  assert.equal(room.host.roomState.epoch, 2);
  assert.equal(room.host.roomState.mediaSeq, 1);
  assert.equal(room.host.roomState.playing, false);
  assert.equal(room.host.roomState.position, 300);
  assert.deepEqual(room.player.calls.slice(-2), ['pause', 'seek:300']);

  room.status(1, 1, 'ready');
  await room.time.advance(1_000);
  assert.equal(room.host.roomState.playing, false);
  room.status(1, 2, 'ready');
  await room.time.advance(300);
  assert.equal(room.host.roomState.playing, true);
  assert.equal(room.host.roomState.position, 300);
});

test('rapid seeks are coalesced into the latest broadcast', async () => {
  const room = setup();
  await openRoom(room);
  await room.time.advance(150);
  const before = room.transport.of('state').length;
  room.host.seek(10);
  room.host.seek(20);
  room.host.seek(30);
  assert.equal(room.transport.of('state').length, before + 1);
  await room.time.advance(100);
  const states = room.transport.of('state');
  assert.equal(states.length, before + 2);
  assert.equal(states.at(-1)?.state.position, 30);
  assert.equal(states.at(-1)?.state.epoch, room.host.roomState.epoch);
  assert.equal(room.player.calls.at(-1), 'seek:30');
});

test('reaching the end of the file turns into a pause intent', async () => {
  const room = setup();
  await openRoom(room);
  const plays = room.player.calls.filter((call) => call === 'play').length;
  room.player.set({ paused: true, position: 1399.8 });
  await room.time.advance(2_000);
  assert.equal(room.host.roomState.playing, false);
  assert.equal(room.host.wantsPlay, false);
  assert.equal(room.player.calls.filter((call) => call === 'play').length, plays);
});

test('a speed change re-anchors a playing room', async () => {
  const room = setup();
  await openRoom(room);
  room.player.set({ position: 100 });
  await settle();
  room.host.setSpeed(3);
  assert.equal(room.host.roomState.speed, 1);
  room.host.setSpeed(2);
  await settle();
  assert.deepEqual(
    { ...room.host.roomState, seq: 0, epoch: 0, mediaSeq: 0, media: null },
    { seq: 0, epoch: 0, mediaSeq: 0, media: null, playing: true, position: 100, hostTime: room.time.now, speed: 2 }
  );
  assert.equal(room.player.calls.at(-1), 'speed:2');
});

test('heartbeats re-anchor a playing room and repeat a paused one', async () => {
  const room = setup();
  await openRoom(room);
  room.player.set({ position: 50 });
  const sampledAt = room.time.now;
  await settle();
  const before = room.host.roomState.seq;
  await room.time.advance(3_000);
  const anchored = room.host.roomState;
  assert.ok(anchored.seq > before);
  assert.equal(anchored.playing, true);
  assert.ok(Math.abs(anchored.position - (50 + (anchored.hostTime - sampledAt) / 1000)) < 1e-6);

  room.host.pause();
  await settle();
  const paused = room.transport.of('state').length;
  const seq = room.host.roomState.seq;
  await room.time.advance(6_000);
  assert.ok(room.transport.of('state').length > paused);
  assert.equal(room.host.roomState.seq, seq);
});

test('pause, play, and stop are host intents', async () => {
  const room = setup();
  await openRoom(room);
  room.host.pause();
  await settle();
  assert.equal(room.host.wantsPlay, false);
  assert.equal(room.host.roomState.playing, false);
  assert.equal(room.player.calls.at(-1), 'pause');
  await room.time.advance(2_000);
  assert.equal(room.host.roomState.playing, false);

  room.host.play();
  assert.equal(room.host.roomState.playing, true);
  await room.time.advance(500);
  assert.equal(room.player.calls.at(-1), 'play');

  const { epoch, mediaSeq } = room.host.roomState;
  room.host.stop();
  await settle();
  assert.deepEqual(
    { ...room.host.roomState, seq: 0, hostTime: 0 },
    { seq: 0, epoch: epoch + 1, mediaSeq: mediaSeq + 1, media: null, playing: false, position: 0, hostTime: 0, speed: 1 }
  );
  assert.equal(room.player.calls.at(-1), 'stop');
  assert.equal(room.host.roster[0].phase, 'idle');
});

test('hosting adopts the episode that is already playing without reloading it', async () => {
  const room = setup();
  room.player.local = localPlayback({ paused: false, position: 400, sampledAt: room.time.now });
  room.host.adopt(media(), room.player.local, 1.5);
  await room.time.advance(1_000);
  assert.deepEqual(room.player.calls, []);
  assert.equal(room.host.roomState.playing, true);
  assert.equal(room.host.roomState.speed, 1.5);
  assert.equal(room.host.roomState.media?.episode, '01');
});

test('pings are answered with the host clock and changes are announced', async () => {
  const room = setup();
  const before = room.changes();
  room.join(1, 'Alice');
  room.host.handleEvent({ type: 'peerPing', id: 1, pingId: 9, sentAt: 123 });
  assert.deepEqual(room.transport.last('pong'), {
    type: 'pong',
    id: 1,
    pingId: 9,
    sentAt: 123,
    hostTime: room.time.now
  });
  assert.equal(room.changes(), before + 1);
  assert.equal(room.host.roster[1].phase, 'idle');
});
