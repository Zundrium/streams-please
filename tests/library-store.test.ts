import assert from 'node:assert/strict';
import test from 'node:test';
import { LibraryStore } from '../src/lib/library-store.svelte.ts';
import type { LibraryEntry, SubsPleaseScheduleShow, SubsPleaseShowResponse } from '../src/lib/types.ts';

function memory(initial: LibraryEntry[] = [], saveResult = true) {
  const saves: LibraryEntry[][] = [];
  return {
    saves,
    persistence: {
      load: () => initial,
      save: (entries: LibraryEntry[]) => {
        saves.push(entries);
        return saveResult;
      }
    }
  };
}

const details = {
  title: 'Show', slug: 'show', synopsis: '', image_url: '', metadata_id: 5, batch: {},
  episode: { a: { episode: '01', show: 'Show', time: '', release_date: '', downloads: [] } }
} as SubsPleaseShowResponse;
const schedule: SubsPleaseScheduleShow = { title: 'Show', page: 'show', image_url: '', time: '' };

test('mutations persist new entries and skip writes when nothing changes', () => {
  const { persistence, saves } = memory();
  const store = new LibraryStore(persistence);
  store.toggleShow(details, schedule);
  assert.equal(store.entries.length, 1);
  assert.equal(saves.length, 1);
  store.syncShow(details, schedule);
  assert.equal(saves.length, 1);
  store.setEpisodeWatched({ anilistId: 5, slug: 'renamed' }, '01', true);
  assert.deepEqual(store.entries[0].watchedEpisodes, ['01']);
  store.toggleEpisodeWatched('show', '01');
  assert.deepEqual(store.entries[0].watchedEpisodes, []);
  store.setEpisodeProgress('show', 1);
  assert.deepEqual(store.entries[0].watchedEpisodes, ['01']);
  store.setVerdict(details, schedule, undefined, 'love');
  assert.equal(store.entries[0].discoveryVerdict, 'love');
  assert.equal(saves.length, 5);
  store.setResumePoint({ anilistId: 5, slug: 'show' }, '02', 95, 1400);
  assert.equal(store.entries[0].resumePoint?.position, 95);
  store.setResumePoint({ anilistId: 5, slug: 'show' }, '02', 95.4, 1400);
  assert.equal(saves.length, 6);
});

test('a failed save keeps the in-memory change and logs once', () => {
  const { persistence } = memory([], false);
  const store = new LibraryStore(persistence);
  const originalError = console.error;
  const logged: unknown[] = [];
  console.error = (message: unknown) => void logged.push(message);
  try {
    store.toggleShow(details, schedule);
  } finally {
    console.error = originalError;
  }
  assert.equal(store.entries.length, 1);
  assert.equal(logged.length, 1);
});

test('imports merge hydrated backups and report shows that could not be refreshed', async () => {
  const { persistence } = memory();
  const store = new LibraryStore(persistence);
  const result = await store.importBackups(
    [
      { slug: 'show', anilistId: 5, following: true, watchedEpisodes: ['01'], addedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { slug: 'gone', following: true, watchedEpisodes: [], addedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
    ],
    {
      timezone: 'UTC',
      loadSchedule: async () => ({ tz: 'UTC', schedule: {} }),
      loadShow: async (slug) => {
        if (slug === 'gone') throw new Error('removed');
        return details;
      }
    }
  );
  assert.deepEqual(result.failed, ['gone']);
  assert.deepEqual(store.entries.map((entry) => entry.slug).sort(), ['gone', 'show']);
});
