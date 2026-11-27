import assert from 'node:assert/strict';
import test from 'node:test';
import { HostClock } from '../src/lib/room/clock.ts';

test('an unsynced clock reports no offset', () => {
  const clock = new HostClock();
  assert.equal(clock.synced, false);
  assert.equal(clock.hostNow(500), 500);
});

test('the sample with the lowest round trip wins despite jitter', () => {
  const clock = new HostClock();
  clock.addSample(1_000, 6_150, 1_200);
  assert.equal(clock.offset, 5_050);
  clock.addSample(2_000, 7_010, 2_020);
  assert.equal(clock.offset, 5_000);
  assert.equal(clock.hostNow(3_000), 8_000);
  clock.addSample(3_000, 8_390, 3_400);
  assert.equal(clock.offset, 5_000);
  assert.equal(clock.synced, true);
});

test('invalid samples are ignored', () => {
  const clock = new HostClock();
  clock.addSample(2_000, 9_000, 1_000);
  clock.addSample(1_000, Number.NaN, 1_100);
  assert.equal(clock.synced, false);
});

test('old samples leave the window and reset clears it', () => {
  const clock = new HostClock();
  clock.addSample(0, 105, 10);
  for (let index = 1; index <= 8; index += 1) {
    const sentAt = index * 1_000;
    clock.addSample(sentAt, sentAt + 250, sentAt + 100);
  }
  assert.equal(clock.offset, 200);
  clock.reset();
  assert.equal(clock.synced, false);
  assert.equal(clock.offset, 0);
});
