import assert from 'node:assert/strict';
import test from 'node:test';
import { matchSubsPleaseShow, normalizeCatalogTitle, searchArchive } from '../src/lib/catalog/matching.ts';
import { shiftSeason } from '../src/lib/catalog/presentation.ts';

const media = (title: string, synonyms: string[] = []) => ({ id: 1, title: { romaji: title }, synonyms });
const provider = (title: string, page = 'series') => ({ title, page });

test('normalizes entities, spacing and roman season markers consistently without a browser', () => {
  assert.equal(normalizeCatalogTitle('Magic &amp; Knights II'), 'magic knights 2');
  assert.equal(matchSubsPleaseShow(media('Ojou-sama'), [provider('Ojousama')])?.confidence, 1);
  assert.equal(matchSubsPleaseShow(media('Magic Knights 2nd Season'), [provider('Magic Knights S2')])?.confidence, 1);
});

test('does not confuse a base series with a numbered sequel or trust an old saved mismatch', () => {
  assert.equal(matchSubsPleaseShow(media('Magic Knights'), [provider('Magic Knights S2')]), undefined);
  assert.equal(matchSubsPleaseShow(media('Magic Knights S2'), [provider('Magic Knights S3')]), undefined);
  assert.equal(matchSubsPleaseShow(media('Magic Knights'), [provider('Other Show')], { '1': 'series' }), undefined);
});

test('uncertain and ambiguous matches never reach confirmed confidence', () => {
  assert.ok((matchSubsPleaseShow(media('Magic Knights'), [provider('Magic Knights Adventure')])?.confidence ?? 1) < 0.95);
  const ambiguous = matchSubsPleaseShow(media('Magic Knights'), [provider('Magic Knights', 'one'), provider('Magic Knights', 'two')]);
  assert.ok(ambiguous && ambiguous.confidence < 0.95);
});

test('archive search and season rollover remain independent of AniList', () => {
  assert.equal(searchArchive('knights magic', [provider('Magic Knights S2')]).length, 1);
  assert.deepEqual(shiftSeason('WINTER', 2026, -1), { season: 'FALL', year: 2025 });
  assert.deepEqual(shiftSeason('FALL', 2026, 1), { season: 'WINTER', year: 2027 });
});
