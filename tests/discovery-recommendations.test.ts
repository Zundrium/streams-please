import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterReviewedRecommendations,
  matchAvailableRecommendations,
  mergeRecommendationDetails,
  recommendationSeedIds
} from '../src/lib/discovery/recommendations.ts';
import { createRecommendationDiscovery } from '../src/lib/discovery/recommendations.svelte.ts';
import { normalizeSearchResponse } from '../src/lib/catalog/cache.ts';
import type { CatalogSearchResponse } from '../src/lib/catalog/providers.ts';
import type { CatalogMedia, DiscoveryVerdict, LibraryEntry } from '../src/lib/types.ts';

function libraryEntry(
  anilistId: number | undefined,
  verdict: DiscoveryVerdict | undefined,
  checkedAt: string | undefined,
  slug = `anime-${anilistId ?? 'unknown'}`
): LibraryEntry {
  return {
    anilistId,
    slug,
    title: slug,
    imageUrl: '',
    following: verdict === 'love',
    discoveryVerdict: verdict,
    checkedAt,
    availableEpisodes: [],
    watchedEpisodes: [],
    addedAt: '2025-01-01T00:00:00.000Z',
    updatedAt: checkedAt ?? '2025-01-01T00:00:00.000Z'
  };
}

function media(id: number, title: string): CatalogMedia {
  return { id, title: { romaji: title } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('recommendation seeds use canonical IDs from the ten most recent loves deterministically', () => {
  const entries = Array.from({ length: 12 }, (_, index) =>
    libraryEntry(index + 1, 'love', `2026-01-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`)
  );
  entries.push(libraryEntry(50, 'maybe', '2027-01-01T00:00:00.000Z'));
  entries.push(libraryEntry(undefined, 'love', '2028-01-01T00:00:00.000Z', 'missing-id'));
  entries.push(libraryEntry(12, 'love', '2026-01-12T12:00:00.000Z', 'duplicate'));

  assert.deepEqual(recommendationSeedIds(entries), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  assert.deepEqual(
    recommendationSeedIds([
      libraryEntry(9, 'love', '2026-01-01T00:00:00.000Z'),
      libraryEntry(3, 'love', '2026-01-01T00:00:00.000Z')
    ]),
    [3, 9]
  );
});

test('recommendations require confirmed archive matches and preserve provider order', () => {
  const recommendations = [media(1, 'Exact Show'), media(2, 'Loose Match'), media(3, 'Mapped Show')];
  const archive = [
    { title: 'Loose Match Adventure', page: 'loose-match-adventure' },
    { title: 'Exact Show', page: 'exact-show' },
    { title: 'Mapped Show', page: 'mapped-show' },
    { title: 'Mapped Show', page: 'mapped-show-copy' }
  ];

  const unmatched = matchAvailableRecommendations(recommendations, archive);
  assert.deepEqual(unmatched.map(({ anime }) => anime.id), [1]);
  const mapped = matchAvailableRecommendations(recommendations, archive, { '3': 'mapped-show' });
  assert.deepEqual(mapped.map(({ anime, provider }) => [anime.id, provider.page]), [
    [1, 'exact-show'],
    [3, 'mapped-show']
  ]);
});

test('reviewed recommendations are excluded by canonical ID or confirmed archive slug', () => {
  const matches = matchAvailableRecommendations(
    [media(1, 'First'), media(2, 'Second'), media(3, 'Third')],
    [
      { title: 'First', page: 'first' },
      { title: 'Second', page: 'second' },
      { title: 'Third', page: 'third' }
    ]
  );
  const remaining = filterReviewedRecommendations(matches, [
    libraryEntry(1, 'pass', '2026-01-01T00:00:00.000Z', 'old-first'),
    libraryEntry(undefined, 'maybe', '2026-01-02T00:00:00.000Z', 'second'),
    libraryEntry(3, undefined, undefined, 'third')
  ]);

  assert.deepEqual(remaining.map(({ anime }) => anime.id), [3]);
});

test('search normalization preserves rich recommendation fields', () => {
  const normalized = normalizeSearchResponse([{
    id: 42,
    idMal: 84,
    title: { romaji: 'Rich recommendation' },
    description: 'Synopsis',
    trailer: { id: 'video', site: 'youtube', thumbnail: 'https://example.com/trailer.jpg' },
    coverImage: { extraLarge: 'https://example.com/poster.jpg' },
    bannerImage: 'https://example.com/banner.jpg',
    genres: ['Adventure'],
    season: 'SPRING',
    seasonYear: 2024,
    startDate: { year: 2024, month: 4, day: 1 },
    endDate: { year: 2024, month: 6, day: 24 },
    format: 'TV',
    status: 'FINISHED',
    episodes: 12,
    duration: 24,
    averageScore: 82,
    popularity: 10_000,
    siteUrl: 'https://anilist.co/anime/42',
    nextAiringEpisode: { episode: 2, airingAt: 1_800_000_000, timeUntilAiring: 60 },
    relations: { edges: [{ relationType: 'PREQUEL', node: { id: 41, title: { romaji: 'Earlier' } } }] }
  }]);

  assert.equal(normalized?.[0].description, 'Synopsis');
  assert.equal(normalized?.[0].trailer?.thumbnail, 'https://example.com/trailer.jpg');
  assert.deepEqual(normalized?.[0].startDate, { year: 2024, month: 4, day: 1 });
  assert.equal(normalized?.[0].nextAiringEpisode?.episode, 2);
  assert.equal(normalized?.[0].relations?.edges?.[0].node?.id, 41);
  assert.equal(normalizeSearchResponse([{ id: 1, title: { romaji: 'Bad' }, startDate: { month: 13 } }]), undefined);
});

test('recommendation metadata enriches provider-only details without losing episodes', () => {
  const details = {
    title: 'Provider title',
    synopsis: 'Provider synopsis',
    image_url: '/provider.jpg',
    slug: 'recommended-show',
    episode: { '01': { time: '', release_date: '', show: 'Provider title', episode: '01', downloads: [] } },
    batch: {}
  };
  const merged = mergeRecommendationDetails(details, {
    id: 42,
    title: { english: 'Canonical title' },
    description: 'Recommendation synopsis',
    trailer: { id: 'video', site: 'youtube', thumbnail: 'https://example.com/trailer.jpg' },
    coverImage: { extraLarge: 'https://example.com/poster.jpg' },
    genres: ['Adventure'],
    startDate: { year: 2024, month: 4, day: 1 },
    format: 'TV',
    episodes: 12,
    siteUrl: 'https://anilist.co/anime/42'
  }, 'AniList');

  assert.equal(merged.title, 'Canonical title');
  assert.equal(merged.metadata_id, 42);
  assert.equal(merged.metadata_source, 'AniList');
  assert.equal(merged.trailer?.id, 'video');
  assert.equal(merged.start_date?.year, 2024);
  assert.equal(merged.episode_count, 12);
  assert.ok(merged.episode['01']);
});

test('recommendation state snapshots seeds until explicit refresh', async () => {
  const calls: number[][] = [];
  const state = createRecommendationDiscovery(async (ids) => {
    calls.push(ids);
    return { results: [media(ids[0], 'Recommendation')] };
  });
  const entries = [libraryEntry(1, 'love', '2026-01-01T00:00:00.000Z')];

  await state.enter(entries);
  entries.push(libraryEntry(2, 'love', '2026-01-02T00:00:00.000Z'));
  await Promise.resolve();
  assert.deepEqual(calls, [[1]]);
  assert.deepEqual(state.seedIds, [1]);

  await state.refresh(entries);
  assert.deepEqual(calls, [[1], [2, 1]]);
  assert.deepEqual(state.seedIds, [2, 1]);
  state.dispose();
});

test('recommendation state exposes loading and recovers from an error on retry', async () => {
  const failed = deferred<CatalogSearchResponse>();
  let attempts = 0;
  const state = createRecommendationDiscovery(() => {
    attempts += 1;
    return attempts === 1
      ? failed.promise
      : Promise.resolve({ results: [media(2, 'Recovered')] });
  });
  const entries = [libraryEntry(1, 'love', '2026-01-01T00:00:00.000Z')];

  const first = state.enter(entries);
  assert.equal(state.loading, true);
  failed.reject(new Error('Recommendations offline'));
  await first;
  assert.equal(state.loading, false);
  assert.equal(state.error, 'Recommendations offline');

  await state.refresh(entries);
  assert.equal(state.error, '');
  assert.equal(state.catalog?.results[0].id, 2);
  state.dispose();
});

test('late recommendation responses cannot overwrite refreshes, mode switches, or disposal', async () => {
  const first = deferred<CatalogSearchResponse>();
  const second = deferred<CatalogSearchResponse>();
  const third = deferred<CatalogSearchResponse>();
  const pending = [first, second, third];
  const state = createRecommendationDiscovery(() => pending.shift()!.promise);
  const entries = [libraryEntry(1, 'love', '2026-01-01T00:00:00.000Z')];

  const oldRequest = state.enter(entries);
  const newRequest = state.refresh(entries);
  second.resolve({ results: [media(2, 'New')] });
  await newRequest;
  first.resolve({ results: [media(1, 'Old')] });
  await oldRequest;
  assert.equal(state.catalog?.results[0].id, 2);

  const switchedRequest = state.refresh(entries);
  state.leave();
  third.reject(new Error('Late failure'));
  await switchedRequest;
  assert.equal(state.active, false);
  assert.equal(state.catalog, null);
  assert.equal(state.error, '');
  assert.equal(state.loading, false);

  state.dispose();
  await state.enter(entries);
  assert.equal(state.active, false);
});
