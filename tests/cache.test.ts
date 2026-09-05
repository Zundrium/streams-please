import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCatalogCache,
  normalizeProviderIndex,
  normalizeSeasonResponse
} from '../src/lib/catalog/cache.ts';
import type { AniListSeasonResponse } from '../src/lib/types.ts';

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function seasonResponse(): AniListSeasonResponse {
  return {
    season: 'SUMMER',
    year: 2026,
    shows: [{ id: 1, title: { romaji: 'Preview Show' }, season: 'SUMMER', seasonYear: 2026 }]
  };
}

test('catalog cache normalizes and expires persisted season data', () => {
  const storage = new MemoryStorage();
  let now = 1_000;
  const cache = createCatalogCache({ storage, now: () => now });
  cache.saveSeason(seasonResponse());

  assert.equal(cache.loadSeason('SUMMER', 2026, 500)?.shows[0].title.romaji, 'Preview Show');
  now = 1_501;
  assert.equal(cache.loadSeason('SUMMER', 2026, 500), undefined);
  assert.equal(cache.loadStaleSeason('SUMMER', 2026)?.shows.length, 1);
});

test('catalog cache rejects malformed nested AniList fields and omits null optionals', () => {
  const show = { id: 1, title: { romaji: 'Preview Show' }, season: 'SUMMER', seasonYear: 2026 };
  const malformedShows = [
    { ...show, title: { romaji: 'Preview Show', english: 42 } },
    { ...show, synonyms: { unsafe: true } },
    { ...show, relations: { edges: {} } },
    { ...show, nextAiringEpisode: { episode: 1, airingAt: {} } }
  ];
  for (const malformedShow of malformedShows) {
    assert.equal(normalizeSeasonResponse({ season: 'SUMMER', year: 2026, shows: [malformedShow] }), undefined);
  }

  const normalized = normalizeSeasonResponse({
    season: 'SUMMER',
    year: 2026,
    shows: [{
      id: 1,
      title: { romaji: 'Preview Show', english: null },
      synonyms: null,
      coverImage: null,
      relations: null,
      nextAiringEpisode: null,
      season: 'SUMMER',
      seasonYear: 2026
    }]
  });
  assert.deepEqual(normalized?.shows[0], seasonResponse().shows[0]);
});

test('catalog cache deduplicates AniList IDs and only accepts backend-safe provider slugs', () => {
  const normalized = normalizeSeasonResponse({
    season: 'SUMMER',
    year: 2026,
    shows: [
      { id: 1, title: { romaji: 'First' }, season: 'SUMMER', seasonYear: 2026 },
      { id: 1, title: { romaji: 'Duplicate' }, season: 'SUMMER', seasonYear: 2026 }
    ]
  });
  assert.deepEqual(normalized?.shows.map((show) => show.title.romaji), ['First']);
  assert.deepEqual(normalizeProviderIndex({
    shows: [{ title: 'Preview', page: 'preview-show-2' }, { title: 'Duplicate', page: 'preview-show-2' }]
  }), { shows: [{ title: 'Preview', page: 'preview-show-2' }] });
  assert.equal(normalizeProviderIndex({ shows: [{ title: 'Unsafe', page: '../preview' }] }), undefined);
  assert.equal(normalizeProviderIndex({ shows: [{ title: 'Uppercase', page: 'Preview' }] }), undefined);
});

test('catalog cache ignores malformed, wrong-season, and future-dated data', () => {
  const storage = new MemoryStorage();
  const cache = createCatalogCache({ storage, now: () => 1_000 });
  storage.setItem(
    'streamsplease.season-cache.v1',
    JSON.stringify({
      entries: {
        'SUMMER:2026': {
          savedAt: 1_001,
          data: { season: 'SUMMER', year: 2026, shows: [] }
        },
        'FALL:2026': {
          savedAt: 900,
          data: { season: 'SUMMER', year: 2026, shows: [] }
        }
      }
    })
  );

  assert.equal(cache.loadStaleSeason('SUMMER', 2026), undefined);
  assert.equal(cache.loadStaleSeason('FALL', 2026), undefined);
});

test('catalog cache keeps preview data separate and tolerates failed writes', () => {
  const storage = new MemoryStorage();
  const preview = createCatalogCache({ storage, scope: 'preview', now: () => 1_000 });
  const native = createCatalogCache({ storage, scope: 'native', now: () => 1_000 });
  preview.saveIndex({ shows: [{ title: ' Preview ', page: 'preview' }] });

  assert.deepEqual(preview.loadIndex(1_000), { shows: [{ title: 'Preview', page: 'preview' }] });
  assert.equal(native.loadIndex(1_000), undefined);

  const unwritable = createCatalogCache({
    storage: { getItem: () => null, setItem: () => { throw new Error('full'); } },
    now: () => 1_000
  });
  assert.doesNotThrow(() => unwritable.saveIndex({ shows: [{ title: 'Preview', page: 'preview' }] }));
});
