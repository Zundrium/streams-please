import assert from 'node:assert/strict';
import test from 'node:test';
import { hydrateLibraryBackups } from '../src/lib/library-import.ts';
import type { LibraryBackupEntry, SubsPleaseShowResponse } from '../src/lib/types.ts';

function backup(slug: string, anilistId?: number): LibraryBackupEntry {
  return {
    anilistId,
    slug,
    following: true,
    discoveryVerdict: 'love',
    watchedEpisodes: ['01'],
    addedAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z'
  };
}

function show(slug: string): SubsPleaseShowResponse {
  return {
    title: `Title ${slug}`,
    synopsis: '',
    image_url: 'img',
    slug,
    episode: { a: { time: '', release_date: '', show: slug, episode: '02', downloads: [] } },
    batch: {}
  } as SubsPleaseShowResponse;
}

test('hydrateLibraryBackups keeps going when a show fails', async () => {
  const batches: number[] = [];
  let active = 0;
  const { entries, failed } = await hydrateLibraryBackups(
    ['a', 'b', 'c', 'd', 'e', 'f'].map((slug, index) => backup(slug, index + 1)),
    {
      timezone: 'UTC',
      concurrency: 2,
      loadSchedule: async () => {
        throw new Error('schedule down');
      },
      loadShow: async (slug) => {
        active += 1;
        batches.push(active);
        await Promise.resolve();
        active -= 1;
        if (slug === 'c') throw new Error('boom');
        return show(slug);
      }
    }
  );
  assert.deepEqual(failed, ['c']);
  assert.equal(entries.length, 6);
  assert.ok(Math.max(...batches) <= 2);
  const fallback = entries[2];
  assert.equal(fallback.slug, 'c');
  assert.equal(fallback.title, 'c');
  assert.equal(fallback.anilistId, 3);
  assert.equal(fallback.imageUrl, '');
  assert.deepEqual(fallback.availableEpisodes, []);
  assert.deepEqual(fallback.watchedEpisodes, ['01']);
  assert.equal(fallback.updatedAt, '2025-01-02T00:00:00.000Z');
  assert.equal(entries[0].title, 'Title a');
  assert.deepEqual(entries[0].availableEpisodes, ['02']);
  assert.equal(entries[0].updatedAt, '2025-01-02T00:00:00.000Z');
});

test('hydrateLibraryBackups returns nothing for an empty backup', async () => {
  const result = await hydrateLibraryBackups([], {
    timezone: 'UTC',
    loadSchedule: async () => ({ tz: 'UTC', schedule: {} }),
    loadShow: async () => {
      throw new Error('unused');
    }
  });
  assert.deepEqual(result, { entries: [], failed: [] });
});

test('hydrateLibraryBackups keeps local metadata when a known show cannot be refreshed', async () => {
  const local = {
    anilistId: 7, slug: 'known', title: 'Known show', imageUrl: 'cover.jpg', following: false,
    availableEpisodes: ['01', '02'], watchedEpisodes: [],
    addedAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z'
  };
  const { entries, failed } = await hydrateLibraryBackups([backup('known', 7)], {
    timezone: 'UTC',
    existing: [local],
    loadSchedule: async () => ({ tz: 'UTC', schedule: {} }),
    loadShow: async () => {
      throw new Error('offline');
    }
  });
  assert.deepEqual(failed, ['known']);
  assert.equal(entries[0].title, 'Known show');
  assert.equal(entries[0].imageUrl, 'cover.jpg');
  assert.deepEqual(entries[0].availableEpisodes, ['01', '02']);
  assert.equal(entries[0].following, true);
  assert.deepEqual(entries[0].watchedEpisodes, ['01']);
});
