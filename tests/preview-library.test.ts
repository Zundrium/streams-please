import assert from 'node:assert/strict';
import test from 'node:test';
import { callPreviewBackend, SINTEL_MAGNET } from '../src/lib/backend/preview.ts';
import { entryFromShow } from '../src/lib/library.ts';
import { currentSeason } from '../src/lib/catalog/presentation.ts';
import type { CatalogProviderResponse } from '../src/lib/catalog/providers.ts';
import type { SubsPleaseShowResponse } from '../src/lib/types.ts';

test('preview identities are stable across search, seasons, and archive details', async () => {
  const current = currentSeason();
  const season = await callPreviewBackend('catalog_request', {
    provider: 'anilist', request: { kind: 'season', ...current }
  }) as CatalogProviderResponse;
  const search = await callPreviewBackend('catalog_request', {
    provider: 'anilist', request: { kind: 'search', query: 'Black Torch' }
  }) as CatalogProviderResponse;
  const details = await callPreviewBackend('subsplease_show', { slug: 'black-torch', timezone: 'UTC' }) as SubsPleaseShowResponse;
  const other = await callPreviewBackend('subsplease_show', { slug: 'liar-game', timezone: 'UTC' }) as SubsPleaseShowResponse;
  assert.equal(search.items[0].id, season.items.find((show) => show.title.romaji === 'Black Torch')?.id);
  assert.equal(details.metadata_id, search.items[0].id);
  assert.notEqual(details.metadata_id, other.metadata_id);
  assert.ok(Object.values(details.episode).every((episode) => episode.downloads.every((download) => download.magnet === SINTEL_MAGNET)));
});

test('browser preview rejects commands it does not implement', async () => {
  await assert.rejects(
    callPreviewBackend('anilist_search' as 'runtime_info'),
    /does not implement anilist_search/
  );
});

test('provider-only episode refresh preserves saved metadata and watched progress', () => {
  const show = { title: 'Provider title', page: 'series', image_url: '', time: '' };
  const metadata: SubsPleaseShowResponse = {
    title: 'Canonical title', slug: 'series', synopsis: 'Metadata synopsis', image_url: 'cover.jpg',
    metadata_id: 1, episode_count: 12, episode: {}, batch: {}, genres: ['Adventure']
  };
  const entry = { ...entryFromShow(metadata, show), watchedEpisodes: ['01'] };
  const refreshed = entryFromShow({
    title: 'Provider title', slug: 'series', synopsis: 'Provider synopsis', image_url: '',
    episode: { '01': { episode: '01', show: 'Provider title', time: '', release_date: '', downloads: [] } }, batch: {}
  }, show, undefined, entry);
  assert.equal(refreshed.title, 'Canonical title');
  assert.equal(refreshed.synopsis, 'Metadata synopsis');
  assert.equal(refreshed.imageUrl, 'cover.jpg');
  assert.equal(refreshed.episodeCount, 12);
  assert.deepEqual(refreshed.watchedEpisodes, ['01']);
  assert.deepEqual(refreshed.availableEpisodes, ['01']);
});
