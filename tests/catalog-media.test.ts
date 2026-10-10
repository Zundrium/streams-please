import assert from 'node:assert/strict';
import test from 'node:test';
import { preferredDownload, scheduledProvider, trailerLinks } from '../src/lib/catalog/media.ts';
import { decodeEntities, metadataLabel, posterUrl, seasonLabel, seasonOrdinal } from '../src/lib/catalog/presentation.ts';
import { validCatalogRequest, validSearchQuery } from '../src/lib/catalog/providers.ts';
import { matchSubsPleaseSeason } from '../src/lib/catalog/matching.ts';

test('posterUrl resolves provider paths and only passes https URLs', () => {
  assert.equal(posterUrl('/imgs/a.jpg'), 'https://subsplease.org/imgs/a.jpg');
  assert.equal(posterUrl('imgs/a.jpg'), 'https://subsplease.org/imgs/a.jpg');
  assert.equal(posterUrl('https://s4.anilist.co/a.jpg'), 'https://s4.anilist.co/a.jpg');
  assert.equal(posterUrl('http://example.com/a.jpg'), '');
  assert.equal(posterUrl(''), '');
});

test('presentation helpers share one label and entity behavior', () => {
  assert.equal(metadataLabel('TV'), 'TV');
  assert.equal(metadataLabel('OVA'), 'OVA');
  assert.equal(metadataLabel('TV_SHORT'), 'Tv Short');
  assert.equal(metadataLabel('NOT_YET_RELEASED'), 'Not Yet Released');
  assert.equal(decodeEntities('Fate &amp; Stay &#039;Night&#39; &#x41;'), "Fate & Stay 'Night' A");
  assert.equal(decodeEntities('Wait&hellip; &ldquo;Hero&rdquo; &mdash; &unknown;'), 'Wait\u2026 \u201cHero\u201d \u2014 &unknown;');
  assert.equal(seasonLabel('FALL'), 'Fall');
  assert.ok(seasonOrdinal('WINTER', 2027) > seasonOrdinal('FALL', 2026));
});

test('trailerLinks builds watch and embed URLs per site', () => {
  const youtube = trailerLinks({ id: 'abc', site: 'YouTube' }, 'https://app.test');
  assert.equal(youtube.watchUrl, 'https://www.youtube.com/watch?v=abc');
  assert.match(youtube.embedUrl, /^https:\/\/www\.youtube\.com\/embed\/abc\?rel=0&playsinline=1&origin=/);
  assert.equal(trailerLinks({ id: 'abc', site: 'youtube' }, 'tauri://localhost').embedUrl.includes('origin'), false);
  assert.deepEqual(trailerLinks({ id: 'x1', site: 'dailymotion' }), {
    watchUrl: 'https://www.dailymotion.com/video/x1',
    embedUrl: 'https://www.dailymotion.com/embed/video/x1'
  });
  assert.deepEqual(trailerLinks({ id: '', site: 'youtube' }), { watchUrl: '', embedUrl: '' });
  assert.deepEqual(trailerLinks(undefined), { watchUrl: '', embedUrl: '' });
});

test('preferredDownload and scheduledProvider pick the expected entries', () => {
  const release = { downloads: [{ res: '480' }, { res: '1080' }, { res: '720' }] } as never;
  assert.equal(preferredDownload(release, '720')?.res, '720');
  assert.equal(preferredDownload({ downloads: [{ res: '480' }, { res: '1080' }] } as never, '720')?.res, '1080');
  const schedule = { schedule: { Monday: [], Friday: [{ page: 'show', title: 'S', time: '10:00', image_url: '' }] } } as never;
  assert.equal(scheduledProvider('show', schedule)?.day, 'Friday');
  assert.equal(scheduledProvider('none', schedule), undefined);
  assert.equal(scheduledProvider('show', null), undefined);
});

test('search query validation counts UTF-8 bytes and rejects controls like the backend', () => {
  const japanese = 'あ'.repeat(60);
  assert.equal(japanese.length, 60);
  assert.equal(validSearchQuery(japanese), false);
  assert.equal(validSearchQuery('あ'.repeat(53)), true);
  assert.equal(validCatalogRequest({ kind: 'search', query: 'あ'.repeat(54) }), false);
  assert.equal(validSearchQuery(' a '), false);
  assert.equal(validSearchQuery('ab\u0085'), false);
  assert.equal(validSearchQuery('ab\u0007c'), false);
  assert.equal(validSearchQuery('  ab  '), true);
});

test('matching repeated lookups against one provider list stays identical', () => {
  const providers = [{ title: 'Magic Knights', page: 'magic-knights' }, { title: 'Other', page: 'other' }];
  const show = { id: 1, title: { romaji: 'Magic Knights' } };
  const first = matchSubsPleaseSeason([show], providers, {});
  const second = matchSubsPleaseSeason([show], providers, {});
  assert.deepEqual([...first], [...second]);
  assert.equal(first.get(1)?.provider.page, 'magic-knights');
});
