import assert from 'node:assert/strict';
import test from 'node:test';
import { Generation } from '../src/lib/async/generation.ts';
import { OperationTracker } from '../src/lib/async/operation-tracker.ts';
import { startPolling } from '../src/lib/async/polling.ts';
import { SerialQueue } from '../src/lib/async/serial-queue.ts';

test('generation tokens go stale once a newer one is issued', () => {
  const generation = new Generation();
  const first = generation.next();
  assert.ok(generation.isCurrent(first));
  const second = generation.next();
  assert.ok(!generation.isCurrent(first));
  assert.ok(generation.isCurrent(second));
  assert.equal(generation.current, second);
});

test('serial queue runs tasks in order and keeps going after a failure', async () => {
  const queue = new SerialQueue();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const first = queue.run(async () => {
    await gate;
    order.push('first');
    throw new Error('boom');
  });
  const second = queue.run(async () => {
    order.push('second');
    return 2;
  });
  release();
  await assert.rejects(first, /boom/);
  assert.equal(await second, 2);
  assert.deepEqual(order, ['first', 'second']);
});

test('polling repeats until the task asks to stop and survives rejected ticks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const stop = startPolling(async () => {
    calls += 1;
    if (calls === 2) throw new Error('transient');
    return calls < 3;
  }, 1_000);
  await Promise.resolve();
  assert.equal(calls, 1);
  for (let tick = 0; tick < 4; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1_000);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 3);
  stop();
});

test('stopping a poller prevents further ticks and reports inactivity to in-flight work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release!: () => void;
  let activeAfterStop: boolean | undefined;
  let calls = 0;
  const stop = startPolling(async (isActive) => {
    calls += 1;
    await new Promise<void>((resolve) => (release = resolve));
    activeAfterStop = isActive();
  }, 10);
  stop();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(100);
  assert.equal(activeAfterStop, false);
  assert.equal(calls, 1);
});

test('operation tracker settles every pending operation regardless of outcome', async () => {
  const tracker = new OperationTracker();
  let resolveOk!: () => void;
  let rejectBad!: (reason: Error) => void;
  const ok = tracker.track(new Promise<void>((resolve) => (resolveOk = resolve)));
  const bad = tracker.track(new Promise<void>((_, reject) => (rejectBad = reject)));
  bad.catch(() => undefined);
  assert.equal(tracker.size, 2);
  const settled = tracker.settled();
  resolveOk();
  rejectBad(new Error('nope'));
  await settled;
  await ok;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tracker.size, 0);
});
