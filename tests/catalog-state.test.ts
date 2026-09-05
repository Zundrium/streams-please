import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalogSearch } from '../src/lib/catalog/search.svelte.ts';
import { createSeasonCatalog } from '../src/lib/catalog/season.svelte.ts';
import type { AniListSearchResult, AniListSeasonResponse, SubsPleaseIndexResponse } from '../src/lib/types.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const index: SubsPleaseIndexResponse = { shows: [{ title: 'Black Torch', page: 'black-torch' }] };
const anime: AniListSearchResult = { id: 1, title: { romaji: 'Black Torch' } };

function createSeason(loadSeason: (season: string, year: number) => Promise<AniListSeasonResponse>) {
  return createSeasonCatalog({
    loadSeason,
    loadIndex: async () => index,
    loadSchedule: async () => ({ tz: 'UTC', schedule: {} }),
    timezone: 'UTC',
    initialSeason: { season: 'SUMMER', year: 2026 }
  });
}

test('a replaced search cannot overwrite newer results or a cleared search', async () => {
  const old = deferred<AniListSearchResult[]>();
  const search = createCatalogSearch((query) => query === 'old' ? old.promise : Promise.resolve([anime]), async () => index);
  const first = search.search('old');
  await search.search('new');
  assert.equal(search.verifiedResults[0].match?.provider.page, 'black-torch');
  search.clear();
  old.resolve([{ id: 2, title: { romaji: 'Old' } }]);
  await first;
  assert.equal(search.query, '');
  assert.deepEqual(search.results, []);
  assert.equal(search.animeLoading, false);
});

test('AniList failure retains labeled archive results and provider failure does not erase anime results', async () => {
  const search = createCatalogSearch(async () => { throw new Error('HTTP 403'); }, async () => index);
  await search.search('Black Torch');
  assert.equal(search.searchError, 'HTTP 403');
  assert.deepEqual(search.archiveResults, index.shows);
  const withoutProvider = createCatalogSearch(async () => [anime], async () => { throw new Error('SubsPlease down'); });
  await withoutProvider.search('Black');
  assert.equal(withoutProvider.results.length, 1);
  assert.equal(withoutProvider.providerError, 'SubsPlease down');
});

test('a slow archive check does not hold AniList results hostage', async () => {
  const pendingIndex = deferred<SubsPleaseIndexResponse>();
  const search = createCatalogSearch(async () => [anime], () => pendingIndex.promise);
  const request = search.search('Black');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(search.results.length, 1);
  assert.equal(search.animeLoading, false);
  assert.equal(search.providerLoading, true);
  pendingIndex.resolve(index);
  await request;
});

test('invalid and disposed searches invalidate pending work', async () => {
  const pending = deferred<AniListSearchResult[]>();
  const search = createCatalogSearch(() => pending.promise, async () => index);
  const request = search.search('Black');
  await search.search('x');
  assert.ok(search.searchError);
  search.dispose();
  pending.resolve([anime]);
  await request;
  assert.deepEqual(search.results, []);
});

test('season changes clear old candidates immediately and reject late responses', async () => {
  const summer = deferred<AniListSeasonResponse>();
  const fall = deferred<AniListSeasonResponse>();
  const catalog = createSeason((season) => season === 'SUMMER' ? summer.promise : fall.promise);
  const first = catalog.load();
  catalog.moveSeason(1);
  assert.equal(Boolean(catalog.catalog), false);
  fall.resolve({ season: 'FALL', year: 2026, shows: [{ ...anime, season: 'FALL', seasonYear: 2026 }] });
  await catalog.refreshSeason();
  summer.resolve({ season: 'SUMMER', year: 2026, shows: [] });
  await first;
  assert.equal(catalog.catalog?.season, 'FALL');
  assert.equal(catalog.seasonMatches.length, 1);
  catalog.moveSeason(-1);
  assert.equal(catalog.catalog, null);
  catalog.dispose();
  await Promise.resolve();
  assert.equal(catalog.catalog, null);
});

test('provider schedule failure is independent of catalog and can be retried', async () => {
  let fail = true;
  const catalog = createSeasonCatalog({
    loadSeason: async () => ({ season: 'SUMMER', year: 2026, shows: [] }),
    loadIndex: async () => index,
    loadSchedule: async () => {
      if (fail) throw new Error('Schedule down');
      return { tz: 'UTC', schedule: {} };
    },
    timezone: 'UTC',
    initialSeason: { season: 'SUMMER', year: 2026 }
  });
  await catalog.load();
  assert.equal(catalog.catalogError, '');
  assert.equal(catalog.scheduleError, 'Schedule down');
  fail = false;
  await catalog.refreshSchedule();
  assert.equal(catalog.scheduleError, '');
  catalog.dispose();
});
