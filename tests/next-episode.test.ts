import assert from 'node:assert/strict';
import test from 'node:test';
import {
  continuationDownload,
  episodePlaybackKey,
  libraryRecommendationCandidates,
  nextRelease,
  planNextEpisode,
  sameEpisode,
  type NextEpisodeDeps
} from '../src/lib/player/next-episode.ts';
import type { EpisodePlaybackRequest, LibraryEntry, SubsPleaseRelease, SubsPleaseShowResponse } from '../src/lib/types.ts';

function release(episode: string, resolutions = ['720', '1080']): SubsPleaseRelease {
  return {
    episode, show: 'Show', time: '', release_date: '',
    downloads: resolutions.map((res) => ({ res, torrent: '', magnet: `magnet:?${episode}-${res}` }))
  };
}

function show(slug: string, episodes: string[]): SubsPleaseShowResponse {
  return {
    title: `Title ${slug}`, slug, synopsis: '', image_url: `/${slug}.jpg`, batch: {},
    episode: Object.fromEntries(episodes.map((episode) => [episode, release(episode)]))
  } as SubsPleaseShowResponse;
}

function entry(slug: string, patch: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    slug, title: slug, imageUrl: '', following: true, availableEpisodes: ['01', '02'],
    watchedEpisodes: [], addedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch
  };
}

const request: EpisodePlaybackRequest = {
  slug: 'current', title: 'Current', imageUrl: '', episode: '02', magnet: 'magnet:?x', quality: '720'
};

function deps(shows: Record<string, SubsPleaseShowResponse>, patch: Partial<NextEpisodeDeps> = {}): NextEpisodeDeps {
  return {
    timezone: 'UTC',
    preferredQuality: '1080',
    libraryEntries: () => [],
    loadShow: async (slug) => {
      const found = shows[slug];
      if (!found) throw new Error('missing');
      return found;
    },
    isCurrent: () => true,
    ...patch
  };
}

test('episode helpers compare numerically and key by slug and episode', () => {
  assert.ok(sameEpisode('01', '1'));
  assert.ok(sameEpisode('12.5', '12.50'));
  assert.ok(!sameEpisode('01', '02'));
  assert.equal(episodePlaybackKey(request), 'current:02');
  assert.equal(nextRelease(show('s', ['10', '9', '11']), '10')?.episode, '11');
  assert.equal(nextRelease(show('s', ['01']), '01'), undefined);
  assert.equal(nextRelease(show('s', ['01']), '05'), undefined);
});

test('continuation keeps the current quality before the preferred one', () => {
  assert.equal(continuationDownload(release('03', ['480', '720']), '720', '1080')?.res, '720');
  assert.equal(continuationDownload(release('03', ['480', '1080']), '720', '1080')?.res, '1080');
  assert.equal(continuationDownload(release('03', ['480', '720']), '360', '1080')?.res, '720');
});

test('library candidates prefer started shows and exclude the current one', () => {
  const entries = [
    entry('fresh'),
    entry('current'),
    entry('started', { watchedEpisodes: ['01'] }),
    entry('done', { watchedEpisodes: ['01', '02'] }),
    entry('unfollowed', { following: false })
  ];
  assert.deepEqual(libraryRecommendationCandidates(entries, request).map((item) => item.slug), ['started', 'fresh']);
});

test('the plan prefers the next released episode of the same show', async () => {
  const plan = await planNextEpisode(request, deps({ current: show('current', ['01', '02', '03']) }));
  assert.equal(plan?.fromLibrary, false);
  assert.equal(plan?.episode?.episode, '03');
  assert.equal(plan?.episode?.quality, '720');
  assert.equal(plan?.episode?.title, 'Title current');
});

test('without a next episode the plan recommends an unfinished library show', async () => {
  const plan = await planNextEpisode(request, deps(
    { current: show('current', ['01', '02']), other: show('other', ['01', '02']) },
    { libraryEntries: () => [entry('broken', { watchedEpisodes: ['01'] }), entry('other', { watchedEpisodes: ['01'] })] }
  ));
  assert.equal(plan?.fromLibrary, true);
  assert.equal(plan?.episode?.slug, 'other');
  assert.equal(plan?.episode?.episode, '02');
});

test('stale plans are discarded and failures clear the suggestion', async () => {
  let current = true;
  const stale = await planNextEpisode(request, deps({}, {
    loadShow: async () => {
      current = false;
      return show('current', ['02', '03']);
    },
    isCurrent: () => current
  }));
  assert.equal(stale, undefined);
  assert.deepEqual(await planNextEpisode(request, deps({})), { episode: null, fromLibrary: false });
  assert.deepEqual(
    await planNextEpisode(request, deps({ current: show('current', ['02']) })),
    { episode: null, fromLibrary: false }
  );
});
