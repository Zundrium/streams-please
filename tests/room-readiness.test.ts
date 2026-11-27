import assert from 'node:assert/strict';
import test from 'node:test';
import { ReadinessTracker, loadingProgress, participantPhase } from '../src/lib/room/readiness.ts';
import type { ReadinessInput } from '../src/lib/room/readiness.ts';

function input(patch: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    attached: true,
    hasMedia: true,
    settled: true,
    phase: 'ready',
    seeking: false,
    downloaded: false,
    bufferedAhead: 30,
    position: 100,
    duration: 1400,
    ...patch
  };
}

test('every phase is derived from the local player', () => {
  assert.equal(participantPhase(input({ attached: false, phase: 'error' }), 'ready'), 'away');
  assert.equal(participantPhase(input({ phase: 'error' }), 'ready'), 'error');
  assert.equal(participantPhase(input({ hasMedia: false }), 'loading'), 'idle');
  assert.equal(participantPhase(input({ phase: 'connecting' }), 'loading'), 'loading');
  assert.equal(participantPhase(input({ phase: 'buffering' }), 'loading'), 'loading');
  assert.equal(participantPhase(input({ settled: false }), 'loading'), 'loading');
  assert.equal(participantPhase(input({ seeking: true }), 'loading'), 'loading');
  assert.equal(participantPhase(input({ bufferedAhead: 4 }), 'loading'), 'loading');
  assert.equal(participantPhase(input(), 'loading'), 'ready');
  assert.equal(participantPhase(input({ bufferedAhead: 0, downloaded: true }), 'loading'), 'ready');
});

test('a missing piece map falls back to mpv state and the end of the file needs less buffer', () => {
  assert.equal(participantPhase(input({ bufferedAhead: null }), 'loading'), 'ready');
  assert.equal(participantPhase(input({ position: 1396, bufferedAhead: 4 }), 'loading'), 'ready');
  assert.equal(participantPhase(input({ position: 1380, bufferedAhead: 4 }), 'loading'), 'loading');
});

test('ready holds through a thin buffer until mpv stalls, then needs the full buffer again', () => {
  const tracker = new ReadinessTracker();
  assert.equal(tracker.update(1, input()).phase, 'ready');
  assert.equal(tracker.update(1, input({ bufferedAhead: 2 })).phase, 'ready');
  assert.equal(tracker.update(1, input({ bufferedAhead: 2, seeking: true })).phase, 'ready');
  assert.equal(tracker.update(1, input({ phase: 'buffering', bufferedAhead: 0 })).phase, 'loading');
  assert.deepEqual(tracker.update(1, input({ bufferedAhead: 5 })), { epoch: 1, phase: 'loading', progress: 0.5 });
  assert.equal(tracker.update(1, input({ bufferedAhead: 10 })).phase, 'ready');
});

test('a new epoch starts from loading again', () => {
  const tracker = new ReadinessTracker();
  assert.equal(tracker.update(1, input()).phase, 'ready');
  assert.equal(tracker.update(2, input({ bufferedAhead: 2 })).phase, 'loading');
});

test('progress is only reported when the buffer is measurable', () => {
  assert.equal(loadingProgress(input({ bufferedAhead: 2.5 })), 0.25);
  assert.equal(loadingProgress(input({ bufferedAhead: 99 })), 1);
  assert.equal(loadingProgress(input({ bufferedAhead: null })), null);
  assert.equal(loadingProgress(input({ settled: false })), null);
  assert.equal(new ReadinessTracker().update(1, input()).progress, null);
});
