import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLibraryExport,
  findLibraryEntryIndex,
  loadLibrary,
  mergeLibraryEntries,
  firstUnwatchedEpisode,
  isSeriesComplete,
  nextUnwatchedEpisode,
  parseLibraryExport,
  resumePosition,
  saveLibrary,
  setEpisodeProgress,
  setEpisodeWatched,
  setResumePoint,
  syncLibraryShow,
  toggleEpisodeWatched,
  toggleLibraryShow,
  applyDiscoveryVerdict,
  watchedCount
} from '../src/lib/library.ts';
import type {
  LibraryEntry,
  SubsPleaseScheduleShow,
  SubsPleaseShowResponse
} from '../src/lib/types.ts';

class MemoryStorage {
  readonly values = new Map<string, string>();
  failWith: Error | undefined;
  failTimes = Infinity;
  get length() {
    return this.values.size;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWith && this.failTimes > 0) {
      this.failTimes -= 1;
      throw this.failWith;
    }
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

function withStorage<T>(storage: MemoryStorage, run: () => T): T {
  const target = globalThis as unknown as { window?: unknown };
  const previous = target.window;
  target.window = { localStorage: storage };
  try {
    return run();
  } finally {
    target.window = previous;
  }
}

const T0 = '2025-01-01T00:00:00.000Z';
const T1 = '2025-02-01T00:00:00.000Z';
const T2 = '2025-03-01T00:00:00.000Z';

function entry(overrides: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    anilistId: 1,
    slug: 'show-a',
    title: 'Show A',
    imageUrl: '',
    following: true,
    availableEpisodes: ['01', '02', '03'],
    watchedEpisodes: [],
    addedAt: T0,
    updatedAt: T0,
    ...overrides
  };
}

function details(slug: string, anilistId?: number, episodes = ['01', '02', '03']): SubsPleaseShowResponse {
  return {
    title: `Title ${slug}`,
    synopsis: 'Synopsis',
    image_url: 'img',
    slug,
    metadata_id: anilistId,
    episode: Object.fromEntries(
      episodes.map((episode) => [
        episode,
        { time: '', release_date: '', show: slug, episode, downloads: [] }
      ])
    ),
    batch: {}
  } as SubsPleaseShowResponse;
}

function scheduleShow(slug: string, anilistId?: number): SubsPleaseScheduleShow {
  return { title: `Title ${slug}`, page: slug, image_url: 'img', time: '12:00', anilist_id: anilistId };
}

test('loadLibrary migrates legacy metadataId and drops malformed entries', () => {
  const storage = new MemoryStorage();
  storage.values.set(
    'streamsplease.library.v2',
    JSON.stringify([
      { slug: 'legacy', title: 'Legacy', metadataId: 42, watchedEpisodes: ['2', '1', '1'] },
      { slug: 'Bad Slug', title: 'Bad' },
      { slug: 'no-title' },
      'junk',
      null
    ])
  );
  const loaded = withStorage(storage, () => loadLibrary());
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].anilistId, 42);
  assert.equal(loaded[0].following, true);
  assert.deepEqual(loaded[0].watchedEpisodes, ['1', '2']);
});

test('loadLibrary repairs duplicate slugs and anilist ids', () => {
  const storage = new MemoryStorage();
  const broken = [
    entry({ anilistId: 1, slug: 'x', watchedEpisodes: ['01'], updatedAt: T0 }),
    entry({ anilistId: 2, slug: 'x', watchedEpisodes: ['02'], updatedAt: T1, title: 'Newer' }),
    entry({ anilistId: 1, slug: 'y', watchedEpisodes: ['03'], updatedAt: T0 }),
    entry({ anilistId: 3, slug: 'z' })
  ];
  storage.values.set('streamsplease.library.v2', JSON.stringify(broken));
  const loaded = withStorage(storage, () => loadLibrary());
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].anilistId, 1);
  assert.equal(loaded[0].slug, 'x');
  assert.equal(loaded[0].title, 'Newer');
  assert.deepEqual(loaded[0].watchedEpisodes, ['01', '02', '03']);
  assert.equal(loaded[1].slug, 'z');
  assert.doesNotThrow(() => parseLibraryExport(createLibraryExport(loaded)));
});

test('export and parse round trip', () => {
  const entries = [entry({ watchedEpisodes: ['02', '01'] }), entry({ anilistId: 2, slug: 'show-b' })];
  const parsed = parseLibraryExport(createLibraryExport(entries));
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0].watchedEpisodes, ['01', '02']);
});

test('mergeLibraryEntries lets the newer side win and unions watched episodes', () => {
  const current = [entry({ following: true, watchedEpisodes: ['01'], updatedAt: T0 })];
  const imported = [entry({ following: false, watchedEpisodes: ['02'], updatedAt: T1 })];
  const [merged] = mergeLibraryEntries(current, imported);
  assert.equal(merged.following, false);
  assert.deepEqual(merged.watchedEpisodes, ['01', '02']);
  const [kept] = mergeLibraryEntries(
    [entry({ following: true, updatedAt: T2 })],
    [entry({ following: false, updatedAt: T1 })]
  );
  assert.equal(kept.following, true);
});

test('findLibraryEntryIndex prefers anilist id then falls back to slug', () => {
  const entries = [entry({ anilistId: 1, slug: 'a' }), entry({ anilistId: 2, slug: 'b' })];
  assert.equal(findLibraryEntryIndex(entries, 2, 'a'), 1);
  assert.equal(findLibraryEntryIndex(entries, 9, 'a'), 0);
  assert.equal(findLibraryEntryIndex(entries, undefined, 'b'), 1);
  assert.equal(findLibraryEntryIndex(entries, 9, 'zzz'), -1);
});

test('following a second anilist show with a used slug does not duplicate', () => {
  const entries = [entry({ anilistId: 1, slug: 'shared', following: false, libraryDismissed: true })];
  const next = toggleLibraryShow(entries, details('shared', 2), scheduleShow('shared', 2), undefined, T1);
  assert.equal(next.length, 1);
  assert.equal(next[0].anilistId, 1);
  assert.equal(next[0].following, true);
  assert.equal(next[0].updatedAt, T1);
  assert.doesNotThrow(() => parseLibraryExport(createLibraryExport(next)));

  const created = toggleLibraryShow([], details('shared', 2), scheduleShow('shared', 2), undefined, T1);
  const again = toggleLibraryShow(created, details('shared', 3), scheduleShow('shared', 3), undefined, T2);
  assert.equal(again.length, 0);
});

test('discovery verdict reuses slug-matched entry and keeps identity', () => {
  const entries = [entry({ anilistId: 1, slug: 'shared' })];
  const next = applyDiscoveryVerdict(entries, details('shared', 2), scheduleShow('shared', 2), undefined, 'love', T1);
  assert.equal(next.length, 1);
  assert.equal(next[0].anilistId, 1);
  assert.equal(next[0].discoveryVerdict, 'love');
  assert.equal(next[0].updatedAt, T1);
  assert.equal(applyDiscoveryVerdict(entries, details('other', 5), scheduleShow('other', 5), undefined), entries);
});

test('syncLibraryShow keeps updatedAt and returns the same reference when unchanged', () => {
  const show = details('show-a', 1);
  const schedule = scheduleShow('show-a', 1);
  const seeded = toggleLibraryShow([], show, schedule, undefined, T0);
  const unchanged = syncLibraryShow(seeded, show, schedule, undefined, T2);
  assert.equal(unchanged, seeded);
  assert.equal(syncLibraryShow(seeded, details('nope', 9), scheduleShow('nope', 9)), seeded);

  const changed = syncLibraryShow(seeded, details('show-a', 1, ['01', '02', '03', '04']), schedule, undefined, T2);
  assert.notEqual(changed, seeded);
  assert.equal(changed[0].updatedAt, T0);
  assert.deepEqual(changed[0].availableEpisodes, ['01', '02', '03', '04']);
  assert.equal(seeded[0].availableEpisodes.length, 3);
});

test('episode reducers resolve by anilist id when slug differs and do not mutate', () => {
  const entries = [entry({ anilistId: 7, slug: 'real-slug' })];
  const identity = { anilistId: 7, slug: 'other-slug' };
  const marked = setEpisodeWatched(entries, identity, '01', true, T1);
  assert.deepEqual(marked[0].watchedEpisodes, ['01']);
  assert.equal(marked[0].updatedAt, T1);
  assert.deepEqual(entries[0].watchedEpisodes, []);
  assert.equal(setEpisodeWatched(marked, identity, '01', true), marked);
  const toggled = toggleEpisodeWatched(marked, identity, '01', T2);
  assert.deepEqual(toggled[0].watchedEpisodes, []);
  assert.equal(toggleEpisodeWatched(entries, { slug: 'missing' }, '01'), entries);
  const progress = setEpisodeProgress(entries, { slug: 'real-slug' }, 2.4, T1);
  assert.deepEqual(progress[0].watchedEpisodes, ['01', '02']);
  assert.equal(setEpisodeProgress(progress, { slug: 'real-slug' }, 2), progress);
  assert.deepEqual(setEpisodeProgress(progress, { slug: 'real-slug' }, 99)[0].watchedEpisodes, ['01', '02', '03']);
});

test('watchedCount and nextUnwatchedEpisode handle mixed episode formats', () => {
  const item = entry({ availableEpisodes: ['1', '2', '12.5', '13'], watchedEpisodes: ['1', '2'] });
  assert.equal(watchedCount(item), 2);
  assert.equal(nextUnwatchedEpisode(item), '12.5');
  const padded = entry({ availableEpisodes: ['01', '02', '10'], watchedEpisodes: ['01', '02'] });
  assert.equal(nextUnwatchedEpisode(padded), '10');
  assert.equal(nextUnwatchedEpisode(entry({ availableEpisodes: ['1'], watchedEpisodes: ['1'] })), undefined);
});

test('isSeriesComplete requires a known episode count with every episode released', () => {
  assert.equal(isSeriesComplete(entry({ episodeCount: 3 })), true);
  assert.equal(isSeriesComplete(entry({ episodeCount: 3, watchedEpisodes: ['01'] })), true);
  assert.equal(isSeriesComplete(entry({ episodeCount: 12 })), false);
  assert.equal(isSeriesComplete(entry()), false);
  assert.equal(isSeriesComplete(entry({ episodeCount: 0, availableEpisodes: [] })), false);
});

test('saveLibrary reports success, failure, and retries after clearing caches on quota errors', () => {
  const ok = new MemoryStorage();
  assert.equal(withStorage(ok, () => saveLibrary([entry()])), true);

  const broken = new MemoryStorage();
  broken.failWith = new Error('denied');
  assert.equal(withStorage(broken, () => saveLibrary([entry()])), false);

  const quota = new MemoryStorage();
  quota.values.set('streamsplease.catalog-results.v1', 'x');
  quota.values.set('streamsplease.season-cache.v1:extra', 'x');
  quota.failWith = Object.assign(new Error('full'), { name: 'QuotaExceededError' });
  quota.failTimes = 1;
  assert.equal(withStorage(quota, () => saveLibrary([entry()])), true);
  assert.equal(quota.values.has('streamsplease.catalog-results.v1'), false);
  assert.equal(quota.values.has('streamsplease.season-cache.v1:extra'), false);
  assert.equal(quota.values.has('streamsplease.library.v2'), true);

  const stuck = new MemoryStorage();
  stuck.failWith = Object.assign(new Error('full'), { name: 'QuotaExceededError' });
  assert.equal(withStorage(stuck, () => saveLibrary([entry()])), false);
});

test('firstUnwatchedEpisode starts new series at the first released episode', () => {
  assert.equal(firstUnwatchedEpisode(['3', '1', '2']), '1');
  assert.equal(firstUnwatchedEpisode(['3', '1', '2'], ['1', '2']), '3');
  assert.equal(firstUnwatchedEpisode(['10', '2', '1'], ['1']), '2');
  assert.equal(firstUnwatchedEpisode(['1', '2'], ['1', '2']), undefined);
  assert.equal(firstUnwatchedEpisode([]), undefined);
});

test('setResumePoint stores one position per series and skips trivial or finished positions', () => {
  const entries = [entry({ anilistId: 7, slug: 'real-slug' })];
  const identity = { anilistId: 7, slug: 'other-slug' };
  const saved = setResumePoint(entries, identity, '02', 754.6, 1420.2, T1);
  assert.deepEqual(saved[0].resumePoint, { episode: '02', position: 754, duration: 1420, updatedAt: T1 });
  assert.equal(saved[0].updatedAt, T1);
  assert.equal(entries[0].resumePoint, undefined);
  assert.equal(setResumePoint(saved, identity, '02', 754.9, 1420, T2), saved);
  assert.equal(setResumePoint(saved, identity, '02', 5, 1420, T2), saved);
  assert.equal(setResumePoint(saved, identity, '02', 1200, 1420, T2), saved);
  assert.equal(setResumePoint(saved, { slug: 'missing' }, '02', 300, 1420, T2), saved);
  const moved = setResumePoint(saved, identity, '03', 300, 0, T2);
  assert.deepEqual(moved[0].resumePoint, { episode: '03', position: 300, updatedAt: T2 });
  const watched = setEpisodeWatched(entries, identity, '01', true, T1);
  assert.equal(setResumePoint(watched, identity, '01', 300, 1420, T2), watched);
});

test('resumePosition only applies to the saved, unwatched episode', () => {
  const item = entry({ resumePoint: { episode: '02', position: 120, updatedAt: T1 } });
  assert.equal(resumePosition(item, '02'), 120);
  assert.equal(resumePosition(item, '03'), 0);
  assert.equal(resumePosition(undefined, '02'), 0);
  assert.equal(resumePosition({ ...item, watchedEpisodes: ['02'] }, '02'), 0);
});

test('marking the resumed episode watched clears the resume point', () => {
  const entries = [entry({ resumePoint: { episode: '02', position: 120, updatedAt: T0 } })];
  assert.equal(setEpisodeWatched(entries, { slug: 'show-a' }, '01', true, T1)[0].resumePoint?.episode, '02');
  assert.equal(setEpisodeWatched(entries, { slug: 'show-a' }, '02', true, T1)[0].resumePoint, undefined);
  assert.equal(setEpisodeProgress(entries, { slug: 'show-a' }, 2, T1)[0].resumePoint, undefined);
});

test('resume points survive sync, storage, export, and merges', () => {
  const point = { episode: '02', position: 120, duration: 1400, updatedAt: T1 };
  const show = details('show-a', 1);
  const schedule = scheduleShow('show-a', 1);
  const seeded = setResumePoint(toggleLibraryShow([], show, schedule, undefined, T0), { slug: 'show-a' }, '02', 120, 1400, T1);
  const synced = syncLibraryShow(seeded, details('show-a', 1, ['01', '02', '03', '04']), schedule, undefined, T2);
  assert.deepEqual(synced[0].resumePoint, point);

  const storage = new MemoryStorage();
  storage.values.set('streamsplease.library.v2', JSON.stringify([
    entry({ resumePoint: point }),
    entry({ anilistId: 2, slug: 'bad-point', resumePoint: { episode: '01', position: -4, updatedAt: T1 } as never }),
    entry({ anilistId: 3, slug: 'watched-point', watchedEpisodes: ['01'], resumePoint: { episode: '01', position: 30, updatedAt: T1 } })
  ]));
  const loaded = withStorage(storage, () => loadLibrary());
  assert.deepEqual(loaded[0].resumePoint, point);
  assert.equal(loaded[1].resumePoint, undefined);
  assert.equal(loaded[2].resumePoint, undefined);

  assert.deepEqual(parseLibraryExport(createLibraryExport([entry({ resumePoint: point })]))[0].resumePoint, point);
  assert.throws(() => parseLibraryExport(JSON.stringify({
    format: 'streamsplease-library',
    version: 1,
    entries: [{ ...entry(), resumePoint: { episode: '01', position: 'soon', updatedAt: T1 } }]
  })), /invalid entry/);

  const later = { episode: '03', position: 60, updatedAt: T2 };
  const [merged] = mergeLibraryEntries(
    [entry({ resumePoint: later, updatedAt: T0 })],
    [entry({ resumePoint: point, updatedAt: T1 })]
  );
  assert.deepEqual(merged.resumePoint, later);
  const [finished] = mergeLibraryEntries(
    [entry({ resumePoint: later, updatedAt: T0 })],
    [entry({ watchedEpisodes: ['03'], updatedAt: T1 })]
  );
  assert.equal(finished.resumePoint, undefined);
});
