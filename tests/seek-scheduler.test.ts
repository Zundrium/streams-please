import assert from 'node:assert/strict';
import test from 'node:test';
import { SeekScheduler } from '../src/lib/player/seek-scheduler.ts';

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('seeks issued while one is in flight collapse into the latest target', async () => {
  const performed: number[] = [];
  const pending: Array<ReturnType<typeof deferred>> = [];
  const seeks = new SeekScheduler({
    perform: (target) => {
      performed.push(target);
      const next = deferred();
      pending.push(next);
      return next.promise;
    },
    canSeek: () => true,
    onError: () => assert.fail('unexpected error')
  });
  seeks.schedule(10);
  seeks.schedule(20);
  seeks.schedule(30);
  assert.equal(seeks.pendingTarget, 30);
  pending[0].resolve();
  await flush();
  pending[1].resolve();
  await flush();
  assert.deepEqual(performed, [10, 30]);
  assert.equal(seeks.pendingTarget, null);
});

test('invalidation drops queued seeks and silences errors from stale ones', async () => {
  const errors: number[] = [];
  const first = deferred();
  const performed: number[] = [];
  const seeks = new SeekScheduler({
    perform: (target) => {
      performed.push(target);
      return target === 1 ? first.promise : Promise.resolve();
    },
    canSeek: () => true,
    onError: (target) => errors.push(target)
  });
  seeks.schedule(1);
  seeks.schedule(2);
  seeks.invalidate();
  first.reject(new Error('stale'));
  await flush();
  assert.deepEqual(performed, [1]);
  assert.deepEqual(errors, []);

  seeks.schedule(3);
  await flush();
  assert.deepEqual(performed, [1, 3]);
});

test('failed current seeks are reported and seeking waits for a seekable player', async () => {
  let seekable = false;
  const errors: number[] = [];
  const tracked: Promise<void>[] = [];
  const seeks = new SeekScheduler({
    perform: async () => {
      throw new Error('nope');
    },
    canSeek: () => seekable,
    onError: (target) => errors.push(target),
    track: (operation) => {
      tracked.push(operation);
      return operation;
    }
  });
  seeks.schedule(5);
  await flush();
  assert.deepEqual(errors, []);
  seekable = true;
  seeks.schedule(6);
  await flush();
  assert.deepEqual(errors, [6]);
  assert.equal(tracked.length, 2);
});
