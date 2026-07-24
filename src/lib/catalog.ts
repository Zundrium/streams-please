import type {
  AnimeSeason,
  AniListMatchableMedia,
  AniListSeasonResponse,
  AniListSeasonShow,
  SubsPleaseIndexResponse,
  SubsPleaseIndexShow
} from '$lib/types';

const PROVIDER_MAP_KEY = 'streamsplease.provider-map.v1';
const PROVIDER_INDEX_CACHE_KEY = 'streamsplease.provider-index.v1';
const SEASON_CACHE_KEY = 'streamsplease.season-cache.v1';
const AVAILABILITY_CACHE_KEY = 'streamsplease.availability-cache.v1';
const MAX_CACHED_SEASONS = 8;
const SEASON_ORDER: AnimeSeason[] = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];

export interface ProviderMatch {
  provider: SubsPleaseIndexShow;
  confidence: number;
}

interface CacheEntry<T> {
  savedAt: number;
  data: T;
}

interface SeasonCache {
  entries: Record<string, CacheEntry<AniListSeasonResponse>>;
}

export interface CachedAvailabilityMatch {
  anilistId: number;
  providerPage: string;
  confidence: number;
}

interface AvailabilityCacheData {
  sourceSignature: string;
  matches: CachedAvailabilityMatch[];
}

interface AvailabilityCache {
  entries: Record<string, CacheEntry<AvailabilityCacheData>>;
}

function readJson<T>(key: string): T | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return JSON.parse(window.localStorage.getItem(key) ?? '') as T;
  } catch {
    return undefined;
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A cache miss is preferable to interrupting catalog browsing.
  }
}

function fresh<T>(entry: CacheEntry<T> | undefined, maxAgeMs: number): T | undefined {
  if (!entry || !Number.isFinite(entry.savedAt) || Date.now() - entry.savedAt > maxAgeMs) {
    return undefined;
  }
  return entry.data;
}

export function loadCachedProviderIndex(maxAgeMs: number): SubsPleaseIndexResponse | undefined {
  const entry = readJson<CacheEntry<SubsPleaseIndexResponse>>(PROVIDER_INDEX_CACHE_KEY);
  const data = fresh(entry, maxAgeMs);
  return data && Array.isArray(data.shows) ? data : undefined;
}

export function saveCachedProviderIndex(data: SubsPleaseIndexResponse): void {
  writeJson(PROVIDER_INDEX_CACHE_KEY, { savedAt: Date.now(), data });
}

export function loadCachedSeason(
  season: AnimeSeason,
  year: number,
  maxAgeMs: number
): AniListSeasonResponse | undefined {
  const cache = readJson<SeasonCache>(SEASON_CACHE_KEY);
  const data = fresh(cache?.entries?.[`${season}:${year}`], maxAgeMs);
  return data && Array.isArray(data.shows) ? data : undefined;
}

export function saveCachedSeason(data: AniListSeasonResponse): void {
  const cache = readJson<SeasonCache>(SEASON_CACHE_KEY) ?? { entries: {} };
  cache.entries[`${data.season}:${data.year}`] = { savedAt: Date.now(), data };
  cache.entries = Object.fromEntries(
    Object.entries(cache.entries)
      .sort(([, left], [, right]) => right.savedAt - left.savedAt)
      .slice(0, MAX_CACHED_SEASONS)
  );
  writeJson(SEASON_CACHE_KEY, cache);
}

export function availabilitySourceSignature(
  catalog: AniListSeasonResponse,
  providerIndex: SubsPleaseIndexResponse
): string {
  let hash = 2_166_136_261;
  const values = [
    `${catalog.season}:${catalog.year}`,
    ...catalog.shows.map((show) => String(show.id)),
    ...providerIndex.shows.flatMap((show) => [show.page, show.title])
  ];
  for (const value of values) {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

export function loadCachedAvailability(
  season: AnimeSeason,
  year: number,
  sourceSignature: string,
  maxAgeMs: number
): CachedAvailabilityMatch[] | undefined {
  const cache = readJson<AvailabilityCache>(AVAILABILITY_CACHE_KEY);
  const data = fresh(cache?.entries?.[`${season}:${year}`], maxAgeMs);
  return data?.sourceSignature === sourceSignature && Array.isArray(data.matches)
    ? data.matches
    : undefined;
}

export function saveCachedAvailability(
  season: AnimeSeason,
  year: number,
  sourceSignature: string,
  matches: CachedAvailabilityMatch[]
): void {
  const cache = readJson<AvailabilityCache>(AVAILABILITY_CACHE_KEY) ?? { entries: {} };
  cache.entries[`${season}:${year}`] = {
    savedAt: Date.now(),
    data: { sourceSignature, matches }
  };
  cache.entries = Object.fromEntries(
    Object.entries(cache.entries)
      .sort(([, left], [, right]) => right.savedAt - left.savedAt)
      .slice(0, MAX_CACHED_SEASONS)
  );
  writeJson(AVAILABILITY_CACHE_KEY, cache);
}

export function currentSeason(date = new Date()): { season: AnimeSeason; year: number } {
  const month = date.getMonth() + 1;
  const season: AnimeSeason =
    month <= 3 ? 'WINTER' : month <= 6 ? 'SPRING' : month <= 9 ? 'SUMMER' : 'FALL';
  return { season, year: date.getFullYear() };
}

export function shiftSeason(
  season: AnimeSeason,
  year: number,
  amount: number
): { season: AnimeSeason; year: number } {
  const absolute = year * 4 + SEASON_ORDER.indexOf(season) + amount;
  return {
    season: SEASON_ORDER[((absolute % 4) + 4) % 4],
    year: Math.floor(absolute / 4)
  };
}

function decodeEntities(value: string): string {
  if (!value || typeof document === 'undefined') return value;
  const textarea = document.createElement('textarea');
  textarea.innerHTML = value;
  return textarea.value;
}

function romanToNumber(value: string): string {
  const values: Record<string, string> = {
    II: '2',
    III: '3',
    IV: '4',
    V: '5',
    VI: '6',
    VII: '7',
    VIII: '8',
    IX: '9',
    X: '10'
  };
  return values[value.toUpperCase()] ?? value;
}

export function normalizeCatalogTitle(value: string): string {
  return decodeEntities(value)
    .replace(
      /\b(II|III|IV|V|VI|VII|VIII|IX|X)(?=\s*(?::|[-–—]|$))/gi,
      (roman) => romanToNumber(roman)
    )
    .toLocaleLowerCase()
    .replace(/\b(\d+)(?:st|nd|rd|th)\s+season\b/g, '$1')
    .replace(/\bseason\s*(\d+)\b/g, '$1')
    .replace(/\bs\s*(\d+)\b/g, '$1')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function titleSeasonNumber(value: string): number | undefined {
  const normalized = decodeEntities(value);
  const numeric =
    /\bs(?:eason)?\s*(\d+)\b/i.exec(normalized)?.[1] ??
    /\b(\d+)(?:st|nd|rd|th)\s+season\b/i.exec(normalized)?.[1];
  if (numeric) return Number(numeric);
  const roman = /\b(II|III|IV|V|VI|VII|VIII|IX|X)(?=\s*(?::|[-–—]|$))/i.exec(
    normalized
  )?.[1];
  if (!roman) return undefined;
  return Number(romanToNumber(roman));
}

interface PreparedTitle {
  compact: string;
  tokens: Set<string>;
}

interface PreparedProvider {
  provider: SubsPleaseIndexShow;
  title: PreparedTitle;
  seasonNumber?: number;
}

function prepareTitle(value: string): PreparedTitle | undefined {
  const normalized = normalizeCatalogTitle(value);
  if (!normalized) return undefined;
  return {
    compact: normalized.replaceAll(' ', ''),
    tokens: new Set(normalized.split(' '))
  };
}

function titleSimilarity(source: PreparedTitle, candidate: PreparedTitle): number {
  if (source.compact === candidate.compact) return 1;
  const shared = [...source.tokens].filter((token) => candidate.tokens.has(token)).length;
  const tokenScore = (2 * shared) / (source.tokens.size + candidate.tokens.size);
  const contains =
    source.compact.includes(candidate.compact) || candidate.compact.includes(source.compact);
  const containmentScore = contains
    ? 0.7 +
      (0.2 * Math.min(source.compact.length, candidate.compact.length)) /
        Math.max(source.compact.length, candidate.compact.length)
    : 0;
  return Math.max(tokenScore, containmentScore);
}

function animeTitles(show: AniListMatchableMedia): string[] {
  return [
    show.title.userPreferred,
    show.title.english,
    show.title.romaji,
    show.title.native,
    ...(show.synonyms ?? [])
  ].filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));
}

export function loadProviderMappings(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PROVIDER_MAP_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveProviderMapping(anilistId: number, slug: string): void {
  if (typeof window === 'undefined' || !anilistId || !slug) return;
  const mappings = loadProviderMappings();
  if (mappings[String(anilistId)] === slug) return;
  mappings[String(anilistId)] = slug;
  window.localStorage.setItem(PROVIDER_MAP_KEY, JSON.stringify(mappings));
}

export function saveProviderMappings(entries: Array<[number, string]>): void {
  if (typeof window === 'undefined' || !entries.length) return;
  const mappings = loadProviderMappings();
  let changed = false;
  for (const [anilistId, slug] of entries) {
    if (!anilistId || !slug || mappings[String(anilistId)] === slug) continue;
    mappings[String(anilistId)] = slug;
    changed = true;
  }
  if (changed) window.localStorage.setItem(PROVIDER_MAP_KEY, JSON.stringify(mappings));
}

export function matchSubsPleaseSeason(
  shows: AniListMatchableMedia[],
  providerShows: SubsPleaseIndexShow[],
  mappings: Record<string, string> = loadProviderMappings()
): Map<number, ProviderMatch> {
  const matches = new Map<number, ProviderMatch>();
  const providersBySlug = new Map(providerShows.map((provider) => [provider.page, provider]));
  const preparedProviders = providerShows.flatMap((provider): PreparedProvider[] => {
    const title = prepareTitle(provider.title);
    return title
      ? [{ provider, title, seasonNumber: titleSeasonNumber(provider.title) }]
      : [];
  });

  for (const show of shows) {
    const savedSlug = mappings[String(show.id)];
    const saved = savedSlug ? providersBySlug.get(savedSlug) : undefined;
    if (saved) {
      matches.set(show.id, { provider: saved, confidence: 1 });
      continue;
    }

    const titles = animeTitles(show);
    const preparedTitles = titles.flatMap((title): PreparedTitle[] => {
      const prepared = prepareTitle(title);
      return prepared ? [prepared] : [];
    });
    const animeSeasonNumbers = new Set(
      titles.map(titleSeasonNumber).filter((value): value is number => value !== undefined)
    );
    let best: ProviderMatch | undefined;

    for (const candidate of preparedProviders) {
      if (
        candidate.seasonNumber !== undefined &&
        animeSeasonNumbers.size > 0 &&
        !animeSeasonNumbers.has(candidate.seasonNumber)
      ) {
        continue;
      }
      let confidence = preparedTitles.reduce(
        (score, title) => Math.max(score, titleSimilarity(title, candidate.title)),
        0
      );
      if (
        candidate.seasonNumber !== undefined &&
        animeSeasonNumbers.has(candidate.seasonNumber)
      ) {
        confidence += 0.08;
      } else if (candidate.seasonNumber === undefined && animeSeasonNumbers.size > 0) {
        confidence -= 0.08;
      }
      if (!best || confidence > best.confidence) {
        best = { provider: candidate.provider, confidence };
      }
    }
    if (best && best.confidence >= 0.68) matches.set(show.id, best);
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
