import type { AniListMatchableMedia, SubsPleaseIndexShow } from '$lib/types';
import { decodeEntities } from '$lib/catalog/presentation';

const PROVIDER_MAP_KEY = 'streamsplease.provider-map.v2';
export const CONFIRMED_MATCH_CONFIDENCE = 0.95;

export interface ProviderMatch {
  provider: SubsPleaseIndexShow;
  confidence: number;
}

const ROMAN_NUMBERS: Record<string, string> = {
  II: '2', III: '3', IV: '4', V: '5', VI: '6', VII: '7', VIII: '8', IX: '9', X: '10'
};

export function normalizeCatalogTitle(value: string): string {
  return decodeEntities(value)
    .replace(/\b(II|III|IV|V|VI|VII|VIII|IX|X)(?=\s*(?::|[-–—]|$))/gi,
      (roman) => ROMAN_NUMBERS[roman.toUpperCase()] ?? roman)
    .toLowerCase()
    .replace(/\b(\d+)(?:st|nd|rd|th)\s+season\b/g, '$1')
    .replace(/\bseason\s*(\d+)\b/g, '$1')
    .replace(/\bs\s*(\d+)\b/g, '$1')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

interface PreparedTitle {
  compact: string;
  tokens: Set<string>;
  numbers: string;
}

interface PreparedProvider {
  provider: SubsPleaseIndexShow;
  title: PreparedTitle;
}

function prepareTitle(value: string): PreparedTitle | undefined {
  const normalized = normalizeCatalogTitle(value);
  if (!normalized) return undefined;
  return {
    compact: normalized.replaceAll(' ', ''),
    tokens: new Set(normalized.split(' ')),
    numbers: [...normalized.matchAll(/\b\d+\b/g)].map(([number]) => number).join(':')
  };
}

function titleSimilarity(source: PreparedTitle, candidate: PreparedTitle): number {
  if (source.compact === candidate.compact) return 1;
  if (source.numbers !== candidate.numbers) return 0;
  const shared = [...source.tokens].filter((token) => candidate.tokens.has(token)).length;
  const tokenScore = (2 * shared) / (source.tokens.size + candidate.tokens.size);
  const contains = source.compact.includes(candidate.compact) || candidate.compact.includes(source.compact);
  const containmentScore = contains
    ? 0.7 + (0.2 * Math.min(source.compact.length, candidate.compact.length)) /
      Math.max(source.compact.length, candidate.compact.length)
    : 0;
  return Math.min(0.94, Math.max(tokenScore, containmentScore));
}

export function animeTitles(show: AniListMatchableMedia): string[] {
  return [show.title.userPreferred, show.title.english, show.title.romaji,
    show.title.native, ...(show.synonyms ?? [])]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));
}

function validMapping(id: string, slug: unknown): slug is string {
  return /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) &&
    typeof slug === 'string' && /^[a-z0-9-]{1,160}$/.test(slug);
}

export function loadProviderMappings(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(PROVIDER_MAP_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([id, slug]) => validMapping(id, slug)));
  } catch {
    return {};
  }
}

export function saveProviderMapping(anilistId: number, slug: string): void {
  if (typeof window === 'undefined' || !validMapping(String(anilistId), slug)) return;
  const mappings = loadProviderMappings();
  if (mappings[String(anilistId)] === slug) return;
  mappings[String(anilistId)] = slug;
  try {
    window.localStorage.setItem(PROVIDER_MAP_KEY, JSON.stringify(mappings));
  } catch {
    return;
  }
}

const preparedProviderCache = new WeakMap<SubsPleaseIndexShow[], PreparedProvider[]>();

function prepareProviders(providerShows: SubsPleaseIndexShow[]): PreparedProvider[] {
  let prepared = preparedProviderCache.get(providerShows);
  if (!prepared) {
    prepared = providerShows.flatMap((provider) => {
      const title = prepareTitle(provider.title);
      return title ? [{ provider, title }] : [];
    });
    preparedProviderCache.set(providerShows, prepared);
  }
  return prepared;
}

export function matchSubsPleaseSeason(
  shows: AniListMatchableMedia[],
  providerShows: SubsPleaseIndexShow[],
  mappings: Record<string, string> = loadProviderMappings()
): Map<number, ProviderMatch> {
  const matches = new Map<number, ProviderMatch>();
  const preparedProviders = prepareProviders(providerShows);

  for (const show of shows) {
    const titles = animeTitles(show).flatMap((title) => {
      const prepared = prepareTitle(title);
      return prepared ? [prepared] : [];
    });
    const ranked = preparedProviders.map(({ provider, title }) => ({
      provider,
      confidence: titles.reduce((score, source) => Math.max(score, titleSimilarity(source, title)), 0)
    })).filter(({ confidence }) => confidence >= 0.68)
      .sort((left, right) => right.confidence - left.confidence);
    const best = ranked[0];
    if (!best) continue;
    const saved = ranked.find(({ provider, confidence }) =>
      provider.page === mappings[String(show.id)] && confidence >= CONFIRMED_MATCH_CONFIDENCE);
    const ambiguous = ranked[1] && best.confidence - ranked[1].confidence < 0.03;
    matches.set(show.id, saved ?? {
      ...best,
      confidence: ambiguous ? Math.min(best.confidence, 0.94) : best.confidence
    });
  }
  return matches;
}

export function matchSubsPleaseShow(
  show: AniListMatchableMedia,
  providerShows: SubsPleaseIndexShow[],
  mappings: Record<string, string> = loadProviderMappings()
): ProviderMatch | undefined {
  return matchSubsPleaseSeason([show], providerShows, mappings).get(show.id);
}

export function searchArchive(query: string, shows: SubsPleaseIndexShow[]): SubsPleaseIndexShow[] {
  const terms = normalizeCatalogTitle(query).split(' ').filter(Boolean);
  if (!terms.length) return [];
  return shows.filter((show) => {
    const title = normalizeCatalogTitle(show.title);
    return terms.every((term) => title.includes(term));
  });
}
