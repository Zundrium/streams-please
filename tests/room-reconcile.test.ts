import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_MEMORY, Reconciler, expectedPosition, reconcile } from '../src/lib/room/reconcile.ts';
import type { ReconcileContext, ReconcileMemory } from '../src/lib/room/reconcile.ts';
import { FakePlayer, FakeTime, localPlayback, media, roomState, settle } from './room-fakes.ts';

const NOW = 50_000;

function context(patch: Partial<ReconcileContext> = {}): ReconcileContext {
  return { now: NOW, hostNow: NOW, synced: true, attached: true, ready: true, correctDrift: true, ...patch };
}

function synced(patch: Partial<ReconcileMemory> = {}): ReconcileMemory {
  return { ...EMPTY_MEMORY, mediaSeq: 1, epoch: 1, alignedPosition: 0, speed: 1, ...patch };
}

function playing(position: number, patch: Partial<ReturnType<typeof roomState>> = {}) {
  return roomState({ playing: true, position, hostTime: NOW, ...patch });
}

test('no room media stops a loaded room episode and leaves other playback alone', () => {
  const target = roomState({ media: null });
  assert.deepEqual(reconcile(target, localPlayback(), synced(), context()).action, { type: 'stop' });
  assert.equal(reconcile(target, localPlayback(), EMPTY_MEMORY, context()).action, null);
});

test('a new media sequence loads the media paused at the room position', () => {
  const result = reconcile(roomState({ mediaSeq: 2, epoch: 4, position: 30 }), localPlayback(), synced(), context());
  assert.deepEqual(result.action, { type: 'load', media: media(), position: 30 });
  assert.equal(result.memory.mediaSeq, 2);
  assert.equal(result.memory.epoch, 4);
  assert.equal(result.memory.speed, null);
});

test('a new epoch on the same media pauses and seeks once', () => {
  const target = roomState({ epoch: 2, position: 300 });
  const first = reconcile(target, localPlayback({ paused: false, position: 20 }), synced(), context());
  assert.deepEqual(first.action, { type: 'seek', position: 300, pause: true, settle: true });
  const second = reconcile(target, localPlayback({ position: 300 }), first.memory, context());
  assert.equal(second.action, null);
});

test('a paused room pauses a playing player', () => {
  const result = reconcile(roomState(), localPlayback({ paused: false }), synced(), context());
  assert.deepEqual(result.action, { type: 'pause' });
});

test('a paused player is aligned once when it is more than the tolerance off', () => {
  const target = roomState({ position: 80 });
  const off = reconcile(target, localPlayback({ position: 80.4 }), synced({ alignedPosition: 60 }), context());
  assert.deepEqual(off.action, { type: 'seek', position: 80, pause: false, settle: false });
  assert.equal(reconcile(target, localPlayback({ position: 80.4 }), off.memory, context()).action, null);
  const close = reconcile(target, localPlayback({ position: 80.05 }), synced({ alignedPosition: 60 }), context());
  assert.equal(close.action, null);
});

test('a scheduled start unpauses at the host time on the local clock', () => {
  const target = playing(10, { hostTime: NOW + 5_400 });
  const result = reconcile(target, localPlayback({ position: 10 }), synced(), context({ hostNow: NOW + 5_000 }));
  assert.deepEqual(result.action, { type: 'play', at: NOW + 400 });
});

test('a playing room unpauses a ready player now and leaves an unready one paused', () => {
  const local = localPlayback({ position: 10 });
  assert.deepEqual(reconcile(playing(10), local, synced(), context()).action, { type: 'play', at: null });
  assert.equal(reconcile(playing(10), local, synced(), context({ ready: false })).action, null);
  const unsynced = reconcile(playing(10, { hostTime: NOW + 400 }), local, synced(), context({ synced: false }));
  assert.deepEqual(unsynced.action, { type: 'play', at: null });
});

test('drift within tolerance keeps the base speed', () => {
  const local = localPlayback({ paused: false, position: 100.05, sampledAt: NOW });
  const result = reconcile(playing(100), local, synced(), context());
  assert.equal(result.action, null);
  assert.equal(result.memory.correction, 0);
});

test('moderate drift is corrected by speed until it is within 30 ms', () => {
  const ahead = localPlayback({ paused: false, position: 100.5, sampledAt: NOW });
  const slow = reconcile(playing(100), ahead, synced(), context());
  assert.deepEqual(slow.action, { type: 'speed', speed: 0.95 });

  const behind = localPlayback({ paused: false, position: 99.5, sampledAt: NOW });
  assert.deepEqual(reconcile(playing(100), behind, synced(), context()).action, { type: 'speed', speed: 1.05 });

  const later = context({ now: NOW + 2_000, hostNow: NOW + 2_000 });
  const closing = localPlayback({ paused: false, position: 102.05, sampledAt: NOW + 2_000 });
  assert.equal(reconcile(playing(100), closing, slow.memory, later).action, null);
  const closed = localPlayback({ paused: false, position: 102.02, sampledAt: NOW + 2_000 });
  assert.deepEqual(reconcile(playing(100), closed, slow.memory, later).action, { type: 'speed', speed: 1 });
});

test('speed corrections change at most once per second', () => {
  const ahead = localPlayback({ paused: false, position: 100.5, sampledAt: NOW });
  const slow = reconcile(playing(100), ahead, synced(), context());
  const soon = context({ now: NOW + 500, hostNow: NOW + 500 });
  const closed = localPlayback({ paused: false, position: 100.5, sampledAt: NOW + 500 });
  assert.equal(reconcile(playing(100), closed, slow.memory, soon).action, null);
});

test('large drift seeks to the expected position at most once per five seconds', () => {
  const local = localPlayback({ paused: false, position: 90, sampledAt: NOW });
  const first = reconcile(playing(100), local, synced(), context());
  assert.deepEqual(first.action, { type: 'seek', position: 100, pause: false, settle: false });
  const soon = context({ now: NOW + 2_000, hostNow: NOW + 2_000 });
  const still = localPlayback({ paused: false, position: 92, sampledAt: NOW + 2_000 });
  assert.equal(reconcile(playing(100), still, first.memory, soon).action, null);
  const later = context({ now: NOW + 5_000, hostNow: NOW + 5_000 });
  const stuck = localPlayback({ paused: false, position: 95, sampledAt: NOW + 5_000 });
  assert.deepEqual(reconcile(playing(100), stuck, first.memory, later).action, {
    type: 'seek',
    position: 105,
    pause: false,
    settle: false
  });
});

test('a host player is never drift corrected', () => {
  const local = localPlayback({ paused: false, position: 90, sampledAt: NOW });
  assert.equal(reconcile(playing(100), local, synced(), context({ correctDrift: false })).action, null);
});

test('a changed room speed sets the base speed', () => {
  const target = roomState({ speed: 1.5 });
  assert.deepEqual(reconcile(target, localPlayback(), synced(), context()).action, { type: 'speed', speed: 1.5 });
  const fast = playing(100, { speed: 2 });
  const local = localPlayback({ paused: false, position: 100, sampledAt: NOW });
  assert.deepEqual(reconcile(fast, local, synced(), context()).action, { type: 'speed', speed: 2 });
});

test('a loading or failed player waits', () => {
  const target = playing(100, { epoch: 2 });
  for (const phase of ['connecting', 'error', 'idle'] as const) {
    assert.equal(reconcile(target, localPlayback({ phase }), synced(), context()).action, null, phase);
  }
  assert.equal(reconcile(target, localPlayback({ duration: 0 }), synced(), context()).action, null);
  const stalled = localPlayback({ phase: 'buffering', paused: false, position: 100 });
  assert.equal(reconcile(playing(100), stalled, synced(), context()).action, null);
});

test('an away guest is kept paused and resyncs from scratch on return', () => {
  const away = context({ attached: false });
  const target = playing(100, { mediaSeq: 2 });
  const paused = reconcile(target, localPlayback({ paused: false }), synced(), away);
  assert.deepEqual(paused.action, { type: 'pause' });
  assert.equal(paused.memory.mediaSeq, 1);
  assert.equal(reconcile(target, localPlayback(), paused.memory, away).action, null);

  const back = reconcile(playing(100), localPlayback({ position: 20 }), paused.memory, context({ hostNow: NOW + 3_000 }));
  assert.deepEqual(back.action, { type: 'seek', position: 103, pause: false, settle: true });
});

test('the expected position follows the anchor and never runs before a scheduled start', () => {
  assert.equal(expectedPosition(roomState({ position: 40, hostTime: 0 }), NOW), 40);
  assert.equal(expectedPosition(playing(40, { speed: 2 }), NOW + 1_500), 43);
  assert.equal(expectedPosition(playing(40, { hostTime: NOW + 500 }), NOW), 40);
});

test('an action in flight is not repeated and newer state is applied after it', async () => {
  const time = new FakeTime();
  const player = new FakePlayer(time);
  let release!: () => void;
  player.loadGate = new Promise<void>((resolve) => (release = resolve));
  const clock = () => ({ hostNow: time.now, synced: true, ready: true });
  let target = roomState({ position: 30 });
  const reconciler = new Reconciler({
    port: player,
    now: time.read,
    setTimer: time.setTimer,
    onWake: () => reconciler.run(target, player.local, clock()),
    correctDrift: true
  });
  player.listener = (local) => {
    reconciler.localChanged();
    reconciler.run(target, local, clock());
  };

  reconciler.run(target, player.local, clock());
  reconciler.run(target, player.local, clock());
  await settle();
  assert.deepEqual(player.calls, ['load:01@30']);
  assert.equal(reconciler.isSettled(target), false);

  target = roomState({ seq: 2, mediaSeq: 2, epoch: 2, media: media('02'), position: 5 });
  reconciler.run(target, player.local, clock());
  assert.deepEqual(player.calls, ['load:01@30']);

  release();
  await settle();
  assert.deepEqual(player.calls, ['load:01@30', 'load:02@5']);
  player.ready({ position: 5 });
  await settle();
  assert.equal(reconciler.isSettled(target), true);
  assert.deepEqual(player.calls, ['load:01@30', 'load:02@5', 'speed:1']);
});

test('a scheduled start is cancelled by a newer state', async () => {
  const time = new FakeTime();
  const player = new FakePlayer(time);
  player.local = localPlayback({ position: 10 });
  let target = roomState({ playing: true, position: 10, hostTime: time.now + 500 });
  const clock = () => ({ hostNow: time.now, synced: true, ready: true });
  const reconciler = new Reconciler({
    port: player,
    now: time.read,
    setTimer: time.setTimer,
    onWake: () => reconciler.run(target, player.local, clock()),
    correctDrift: false
  });
  reconciler.adopt(roomState());

  reconciler.run(target, player.local, clock());
  await time.advance(200);
  assert.deepEqual(player.calls, []);
  target = roomState({ seq: 3, position: 10 });
  reconciler.run(target, player.local, clock());
  await time.advance(1_000);
  assert.deepEqual(player.calls, []);

  target = roomState({ seq: 4, playing: true, position: 10, hostTime: time.now + 500 });
  reconciler.run(target, player.local, clock());
  await time.advance(499);
  assert.deepEqual(player.calls, []);
  await time.advance(1);
  assert.deepEqual(player.calls, ['play']);
});
