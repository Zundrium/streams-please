import assert from 'node:assert/strict';
import test from 'node:test';
import { StreamLifecycle, selectedFileProgress } from '../src/lib/player/stream-lifecycle.ts';
import type { CurrentTorrent, Phase, TorrentStats } from '../src/lib/types.ts';

const MB = 1024 * 1024;
const torrent: CurrentTorrent = {
  id: 7,
  fileId: 1,
  details: { info_hash: 'x', output_folder: '' },
  video: { name: 'a.mkv', components: ['a.mkv'], length: 100 * MB, included: true }
};

function statsWith(fileBytes: number, patch: Partial<TorrentStats> = {}): TorrentStats {
  return {
    state: 'live', file_progress: [0, fileBytes], progress_bytes: fileBytes,
    uploaded_bytes: 0, total_bytes: 100 * MB, finished: false, ...patch
  };
}

function lifecycle() {
  let phase: Phase = 'buffering';
  let error = '';
  const transitions: string[] = [];
  const stream = new StreamLifecycle({
    minStartBytes: MB,
    retryDelayMs: 5_000,
    maxFailures: 3,
    watchdogMs: 20_000,
    phase: () => phase,
    onPhase: (next, message) => {
      phase = next;
      if (message !== undefined) error = message;
      transitions.push(next);
    }
  });
  return { stream, transitions, state: () => ({ phase, error }) };
}

test('selected file progress falls back to overall progress', () => {
  assert.equal(selectedFileProgress(torrent, statsWith(5)), 5);
  assert.equal(selectedFileProgress(torrent, { ...statsWith(5), file_progress: [] }), 5);
  assert.equal(selectedFileProgress(torrent, null), 0);
});

test('an attempt is claimed only once enough of the selected file is downloaded', () => {
  const { stream } = lifecycle();
  stream.begin(torrent);
  assert.equal(stream.claimAttempt(), null);
  stream.updateStats(statsWith(MB / 2));
  assert.equal(stream.claimAttempt(), null);
  stream.updateStats(statsWith(MB));
  const attempt = stream.claimAttempt();
  assert.ok(attempt !== null && stream.isCurrent(attempt));
  assert.equal(stream.claimAttempt(), null);
});

test('finished torrents can start immediately while errored torrents never do', () => {
  const { stream } = lifecycle();
  stream.begin(torrent);
  stream.updateStats(statsWith(0, { state: 'error' }));
  assert.equal(stream.claimAttempt(), null);
  stream.updateStats(statsWith(0, { finished: true }));
  assert.notEqual(stream.claimAttempt(), null);
});

test('failures back off, invalidate the attempt, and give up after the limit', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { stream, state } = lifecycle();
  stream.begin(torrent);
  stream.updateStats(statsWith(MB));

  const first = stream.claimAttempt()!;
  stream.fail('no data', first);
  assert.ok(!stream.isCurrent(first));
  assert.deepEqual(state(), { phase: 'buffering', error: '' });
  assert.equal(stream.claimAttempt(), null);
  t.mock.timers.tick(5_000);

  stream.fail('stale', first);
  const second = stream.claimAttempt()!;
  stream.fail('no data', second);
  t.mock.timers.tick(5_000);
  const third = stream.claimAttempt()!;
  stream.fail('no data', third);

  assert.deepEqual(state(), { phase: 'error', error: 'no data The local stream was attempted 3 times.' });
  t.mock.timers.tick(60_000);
  assert.equal(stream.claimAttempt(), null);
});

test('reaching playback resets the failure budget', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { stream, state } = lifecycle();
  stream.begin(torrent);
  stream.updateStats(statsWith(MB));
  stream.fail('ignored without a started stream', stream.claimAttempt()!);
  t.mock.timers.tick(5_000);
  stream.claimAttempt();
  stream.markReady();
  assert.deepEqual(state(), { phase: 'ready', error: '' });
});

test('the watchdog fails a stream that stays paused for cache', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { stream, state } = lifecycle();
  stream.begin(torrent);
  stream.updateStats(statsWith(MB));
  stream.claimAttempt();
  stream.cacheStateChanged(true, true);
  t.mock.timers.tick(19_999);
  assert.equal(state().phase, 'buffering');
  t.mock.timers.tick(1);
  assert.equal(state().error, '');
  assert.equal(stream.claimAttempt(), null);
  t.mock.timers.tick(5_000);
  assert.notEqual(stream.claimAttempt(), null);
});

test('cache recovery and observed progress mark the stream ready unless still paused', () => {
  const { stream, state, transitions } = lifecycle();
  stream.begin(torrent);
  stream.updateStats(statsWith(MB));
  stream.claimAttempt();
  stream.fileStarted();
  stream.progressObserved();
  assert.equal(state().phase, 'buffering');
  stream.cacheStateChanged(false, false);
  assert.equal(state().phase, 'buffering');
  stream.progressObserved();
  assert.equal(state().phase, 'ready');
  stream.cacheStateChanged(true, true);
  stream.cacheStateChanged(false, true);
  assert.deepEqual(transitions.slice(-2), ['buffering', 'ready']);
  stream.dispose();
});

test('suspending or replacing the torrent invalidates in-flight attempts', () => {
  const { stream } = lifecycle();
  stream.begin(torrent);
  stream.updateStats(statsWith(MB));
  const attempt = stream.claimAttempt()!;
  stream.suspend();
  assert.ok(!stream.isCurrent(attempt));
  stream.begin(null);
  assert.equal(stream.torrent, null);
  assert.equal(stream.stats, null);
  stream.markReady();
});

test('a manual retry restarts the budget and claims only with buffered data', () => {
  const { stream } = lifecycle();
  stream.begin(torrent);
  stream.restart();
  assert.equal(stream.claimRetry(), null);
  stream.updateStats(statsWith(MB, { live: {
    download_speed: { mbps: 1 }, upload_speed: { mbps: 0 },
    snapshot: { peer_stats: { live: 4, seen: 4, connecting: 0 } }
  } }));
  assert.equal(stream.livePeers, 4);
  assert.notEqual(stream.claimRetry(), null);
});
