import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatRatio,
  formatUploadSpeed,
  normalizeSeedingOverview,
  percentOf,
  seedingDetail
} from '../src/lib/torrent/seeding.ts';

const HASH = '08ada5a7a6183aae1e09d831df6748d566095a10';

test('seeding overviews are normalized at the IPC boundary', () => {
  const overview = normalizeSeedingOverview({
    targetRatio: 2,
    defaultTargetRatio: 1.5,
    cacheLimitBytes: 10,
    cacheUsedBytes: -4,
    totalUploadedBytes: 'many',
    uploadSpeedMbps: 0.5,
    episodes: [
      { infoHash: HASH.toUpperCase(), name: '  Episode 1  ', status: 'seeding', sizeBytes: 100, ratio: 1.2, peers: 2.7 },
      { infoHash: '../escape', name: 'Bad', status: 'seeding' },
      { infoHash: HASH.replace('0', 'f'), status: 'unknown', error: 'disk full' },
      null
    ]
  });
  assert.equal(overview.targetRatio, 2);
  assert.equal(overview.cacheUsedBytes, 0);
  assert.equal(overview.totalUploadedBytes, 0);
  assert.equal(overview.episodes.length, 2);
  assert.deepEqual(overview.episodes[0], {
    infoHash: HASH,
    name: 'Episode 1',
    status: 'seeding',
    sizeBytes: 100,
    downloadedBytes: 0,
    uploadedBytes: 0,
    ratio: 1.2,
    uploadSpeedMbps: 0,
    peers: 2,
    addedAt: 0,
    lastActiveAt: 0
  });
  assert.equal(overview.episodes[1].status, 'error');
  assert.equal(overview.episodes[1].name, HASH.replace('0', 'f').slice(0, 12));
  assert.equal(overview.episodes[1].error, 'disk full');
});

test('missing overview data falls back to the default ratio and no episodes', () => {
  const overview = normalizeSeedingOverview(undefined);
  assert.equal(overview.targetRatio, 1.5);
  assert.deepEqual(overview.episodes, []);
});

test('seeding values are formatted for display', () => {
  assert.equal(formatRatio(1.234), '1.23');
  assert.equal(formatRatio(Number.NaN), '0.00');
  assert.equal(formatUploadSpeed(0), '0 KiB/s');
  assert.equal(formatUploadSpeed(0.5), '512 KiB/s');
  assert.equal(formatUploadSpeed(2), '2.00 MiB/s');
  assert.equal(percentOf(3, 2), 100);
  assert.equal(percentOf(1, 4), 25);
  assert.equal(percentOf(1, 0), 0);
});

test('streaming episodes explain when the ratio target is already met', () => {
  const episode = normalizeSeedingOverview({
    episodes: [{ infoHash: HASH, status: 'streaming', ratio: 1.6 }]
  }).episodes[0];
  assert.match(seedingDetail(episode, 1.5), /Removed after you stop watching/);
  assert.match(seedingDetail({ ...episode, status: 'seeding' }, 1.5), /1\.50 ratio/);
});
