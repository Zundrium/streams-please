import assert from 'node:assert/strict';
import test from 'node:test';
import {
  candidateKey,
  candidateTiming,
  hasSeriesPrequel,
  isObviousSequelTitle,
  toAiringCandidate,
  toRecommendationCandidate
} from '../src/lib/discovery/airing.ts';

test('isObviousSequelTitle flags numbered and spelled-out continuations', () => {
  for (const title of ['Show 2nd Season', 'Show Part 2', 'Show Season 3', 'Show S2', 'Show Cour 2',
    'Show Second Season', 'Fate &amp; Night Season 2']) {
    assert.equal(isObviousSequelTitle(title), true, title);
  }
  for (const title of ['Show Season 1', 'Show', 'Show Part 1', 'Show 2']) {
    assert.equal(isObviousSequelTitle(title), false, title);
  }
});

test('hasSeriesPrequel only counts anime TV, TV short, or ONA prequels', () => {
  const edge = (relationType: string, type: string, format: string) =>
    ({ relationType, node: { id: 1, type, format } });
  const show = (...edges: unknown[]) => ({ id: 1, relations: { edges } }) as never;
  assert.equal(hasSeriesPrequel(show(edge('PREQUEL', 'ANIME', 'TV'))), true);
  assert.equal(hasSeriesPrequel(show(edge('PREQUEL', 'ANIME', 'MOVIE'))), false);
  assert.equal(hasSeriesPrequel(show(edge('SEQUEL', 'ANIME', 'TV'))), false);
  assert.equal(hasSeriesPrequel(show(edge('PREQUEL', 'MANGA', 'TV'))), false);
  assert.equal(hasSeriesPrequel({ id: 1 } as never), false);
});

test('candidates map matches and expose keys and timing', () => {
  const anime = { id: 7, title: { english: 'Show' }, coverImage: { large: 'https://img.test/a.jpg' }, startDate: { year: 2026, month: 7, day: 4 } } as never;
  const airing = toAiringCandidate(
    { anime, provider: { title: 'Show', page: 'show' }, confidence: 1, day: 'Friday',
      schedule: { title: 'Show', page: 'show', image_url: '', time: '10:00' } },
    'SUMMER', 2026
  );
  assert.ok(airing);
  assert.equal(candidateKey(airing), 'airing:7:show');
  assert.equal(candidateTiming(airing), 'Friday · 10:00');
  assert.equal(airing.show.image_url, 'https://img.test/a.jpg');
  assert.equal(toAiringCandidate(
    { anime: { ...(anime as object), title: { english: 'Show Season 2' } } as never, provider: { title: 'x', page: 'x' }, confidence: 1 },
    'SUMMER', 2026
  ), undefined);
  const recommendation = toRecommendationCandidate({ anime, provider: { title: 'Show', page: 'show' } });
  assert.equal(candidateKey(recommendation), 'recommendations:7:show');
  assert.match(candidateTiming(recommendation), /2026/);
  assert.equal(candidateKey(undefined), '');
});
