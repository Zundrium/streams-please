import type {
  AnimeSeason,
  AniListDate,
  AniListMediaTitle,
  AniListRelationEdge,
  AniListRelationNode,
  AniListSearchResult,
  AniListSeasonResponse,
  AniListSeasonShow,
  SubsPleaseIndexResponse,
  SubsPleaseIndexShow
} from '$lib/types';

const PROVIDER_INDEX_CACHE_KEY = 'streamsplease.provider-index.v1';
const SEASON_CACHE_KEY = 'streamsplease.season-cache.v1';
const MAX_CACHED_SEASONS = 8;
const MAX_INDEX_SHOWS = 3_000;
const MAX_SEASON_SHOWS = 200;
const MAX_RELATION_EDGES = 100;
const MAX_GENRES = 100;
const MAX_SYNONYMS = 100;
const SEASONS: readonly AnimeSeason[] = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
const INVALID = Symbol('invalid');

type Invalid = typeof INVALID;

export type CatalogCacheScope = 'native' | 'preview';

export interface CatalogStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CatalogCacheOptions {
  storage?: CatalogStorage;
  scope?: CatalogCacheScope;
  now?: () => number;
}

interface CacheEntry<T> {
  savedAt: number;
  data: T;
}

function storageForBrowser(): CatalogStorage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validSeason(value: unknown): value is AnimeSeason {
  return typeof value === 'string' && SEASONS.includes(value as AnimeSeason);
}

function validYear(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1940 && value <= 2200;
}

function validDateYear(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 9_999;
}

function optionalString(value: unknown, maxLength: number): string | undefined | Invalid {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' && value.length <= maxLength ? value : INVALID;
}

function optionalInteger(value: unknown, minimum = 0): number | undefined | Invalid {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : INVALID;
}

function optionalStringArray(
  value: unknown,
  maximumItems: number,
  maximumStringLength: number
): string[] | undefined | Invalid {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > maximumItems) return INVALID;
  return value.every((item) => typeof item === 'string' && item.length <= maximumStringLength)
    ? [...value]
    : INVALID;
}

function normalizeTitle(value: unknown): AniListMediaTitle | undefined {
  if (!isRecord(value)) return undefined;
  const romaji = optionalString(value.romaji, 500);
  const english = optionalString(value.english, 500);
  const native = optionalString(value.native, 500);
  const userPreferred = optionalString(value.userPreferred, 500);
  const fields = [romaji, english, native, userPreferred];
  if (fields.some((item) => item === INVALID)) return undefined;
  if (!fields.some((item) => typeof item === 'string' && Boolean(item.trim()))) return undefined;
  const title: AniListMediaTitle = {};
  if (typeof romaji === 'string') title.romaji = romaji;
  if (typeof english === 'string') title.english = english;
  if (typeof native === 'string') title.native = native;
  if (typeof userPreferred === 'string') title.userPreferred = userPreferred;
  return title;
}

function normalizeCoverImage(value: unknown): AniListSeasonShow['coverImage'] | undefined | Invalid {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return INVALID;
  const extraLarge = optionalString(value.extraLarge, 2_000);
  const large = optionalString(value.large, 2_000);
  const color = optionalString(value.color, 100);
  if ([extraLarge, large, color].some((item) => item === INVALID)) return INVALID;
  const coverImage: NonNullable<AniListSeasonShow['coverImage']> = {};
  if (typeof extraLarge === 'string') coverImage.extraLarge = extraLarge;
  if (typeof large === 'string') coverImage.large = large;
  if (typeof color === 'string') coverImage.color = color;
  return coverImage;
}

function normalizeDate(value: unknown): AniListDate | undefined | Invalid {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return INVALID;
  const year = value.year === undefined || value.year === null
    ? undefined
    : validDateYear(value.year) ? value.year : INVALID;
  const month = optionalInteger(value.month, 1);
  const day = optionalInteger(value.day, 1);
  if (
    year === INVALID ||
    month === INVALID ||
    day === INVALID ||
    (typeof month === 'number' && month > 12) ||
    (typeof day === 'number' && day > 31)
  ) {
    return INVALID;
  }
  const date: AniListDate = {};
  if (typeof year === 'number') date.year = year;
  if (typeof month === 'number') date.month = month;
  if (typeof day === 'number') date.day = day;
  return date;
}

function normalizeRelationNode(value: unknown): AniListRelationNode | undefined {
  if (!isRecord(value)) return undefined;
  const id = value.id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return undefined;
  const title = normalizeTitle(value.title);
  const synonyms = optionalStringArray(value.synonyms, MAX_SYNONYMS, 500);
  const type = optionalString(value.type, 100);
  const format = optionalString(value.format, 100);
  const status = optionalString(value.status, 100);
  const season = value.season === undefined || value.season === null
    ? undefined
    : validSeason(value.season) ? value.season : INVALID;
  const seasonYear = value.seasonYear === undefined || value.seasonYear === null
    ? undefined
    : validYear(value.seasonYear) ? value.seasonYear : INVALID;
  const coverImage = normalizeCoverImage(value.coverImage);
  const siteUrl = optionalString(value.siteUrl, 2_000);
  if (
    !title ||
    [synonyms, type, format, status, season, seasonYear, coverImage, siteUrl].some((item) => item === INVALID)
  ) {
    return undefined;
  }
  const node: AniListRelationNode = { id, title };
  if (Array.isArray(synonyms)) node.synonyms = synonyms;
  if (typeof type === 'string') node.type = type;
  if (typeof format === 'string') node.format = format;
  if (typeof status === 'string') node.status = status;
  if (typeof season === 'string') node.season = season;
  if (typeof seasonYear === 'number') node.seasonYear = seasonYear;
  if (coverImage && coverImage !== INVALID) node.coverImage = coverImage;
  if (typeof siteUrl === 'string') node.siteUrl = siteUrl;
  return node;
}

function normalizeRelations(value: unknown): AniListSeasonShow['relations'] | undefined | Invalid {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return INVALID;
  const edgesValue = value.edges;
  if (edgesValue === undefined || edgesValue === null) return {};
  if (!Array.isArray(edgesValue) || edgesValue.length > MAX_RELATION_EDGES) return INVALID;
  const edges: AniListRelationEdge[] = [];
  for (const valueEdge of edgesValue) {
    if (!isRecord(valueEdge)) return INVALID;
    const relationType = optionalString(valueEdge.relationType, 100);
    const nodeValue = valueEdge.node;
    const node = nodeValue === undefined || nodeValue === null ? undefined : normalizeRelationNode(nodeValue);
    if (relationType === INVALID || (nodeValue !== undefined && nodeValue !== null && !node)) return INVALID;
    const edge: AniListRelationEdge = {};
    if (typeof relationType === 'string') edge.relationType = relationType;
    if (node) edge.node = node;
    edges.push(edge);
  }
  return { edges };
}

function normalizeSeasonShow(value: unknown): AniListSeasonShow | undefined {
  if (!isRecord(value)) return undefined;
  const id = value.id;
  const season = value.season;
  const seasonYear = value.seasonYear;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return undefined;
  const title = normalizeTitle(value.title);
  if (!title || !validSeason(season) || !validYear(seasonYear)) return undefined;

  const idMal = optionalInteger(value.idMal, 1);
  const description = optionalString(value.description, 100_000);
  const synonyms = optionalStringArray(value.synonyms, MAX_SYNONYMS, 500);
  const trailer = value.trailer;
  const coverImage = normalizeCoverImage(value.coverImage);
  const bannerImage = optionalString(value.bannerImage, 2_000);
  const genres = optionalStringArray(value.genres, MAX_GENRES, 100);
  const startDate = normalizeDate(value.startDate);
  const endDate = normalizeDate(value.endDate);
  const format = optionalString(value.format, 100);
  const status = optionalString(value.status, 100);
  const episodes = optionalInteger(value.episodes);
  const duration = optionalInteger(value.duration);
  const averageScore = optionalInteger(value.averageScore);
  const popularity = optionalInteger(value.popularity);
  const siteUrl = optionalString(value.siteUrl, 2_000);
  const relations = normalizeRelations(value.relations);
  if (
    [
      idMal, description, synonyms, coverImage, bannerImage, genres, startDate, endDate, format,
      status, episodes, duration, averageScore, popularity, siteUrl, relations
    ].some((item) => item === INVALID)
  ) {
    return undefined;
  }

  let normalizedTrailer: AniListSeasonShow['trailer'];
  if (trailer !== undefined && trailer !== null) {
    if (!isRecord(trailer)) return undefined;
    const id = optionalString(trailer.id, 500);
    const site = optionalString(trailer.site, 100);
    const thumbnail = optionalString(trailer.thumbnail, 2_000);
    if (typeof id !== 'string' || !id || typeof site !== 'string' || !site || thumbnail === INVALID) {
      return undefined;
    }
    normalizedTrailer = { id, site };
    if (typeof thumbnail === 'string') normalizedTrailer.thumbnail = thumbnail;
  }

  const nextAiring = value.nextAiringEpisode;
  let nextAiringEpisode: AniListSeasonShow['nextAiringEpisode'];
  if (nextAiring !== undefined && nextAiring !== null) {
    if (!isRecord(nextAiring)) return undefined;
    const episode = optionalInteger(nextAiring.episode, 1);
    const airingAt = optionalInteger(nextAiring.airingAt, 1);
    const timeUntilAiring = optionalInteger(nextAiring.timeUntilAiring);
    if (
      typeof episode !== 'number' ||
      typeof airingAt !== 'number' ||
      typeof timeUntilAiring !== 'number'
    ) {
      return undefined;
    }
    nextAiringEpisode = { episode, airingAt, timeUntilAiring };
  }

  const show: AniListSeasonShow = { id, title, season, seasonYear };
  if (typeof idMal === 'number') show.idMal = idMal;
  if (typeof description === 'string') show.description = description;
  if (Array.isArray(synonyms)) show.synonyms = synonyms;
  if (normalizedTrailer) show.trailer = normalizedTrailer;
  if (coverImage && coverImage !== INVALID) show.coverImage = coverImage;
  if (typeof bannerImage === 'string') show.bannerImage = bannerImage;
  if (Array.isArray(genres)) show.genres = genres;
  if (startDate && startDate !== INVALID) show.startDate = startDate;
  if (endDate && endDate !== INVALID) show.endDate = endDate;
  if (typeof format === 'string') show.format = format;
  if (typeof status === 'string') show.status = status;
  if (typeof episodes === 'number') show.episodes = episodes;
  if (typeof duration === 'number') show.duration = duration;
  if (typeof averageScore === 'number') show.averageScore = averageScore;
  if (typeof popularity === 'number') show.popularity = popularity;
  if (typeof siteUrl === 'string') show.siteUrl = siteUrl;
  if (nextAiringEpisode) show.nextAiringEpisode = nextAiringEpisode;
  if (relations && relations !== INVALID) show.relations = relations;
  return show;
}

export function normalizeSearchResponse(value: unknown): AniListSearchResult[] | undefined {
  if (!Array.isArray(value) || value.length > 50) return undefined;
  const results = new Map<number, AniListSearchResult>();
  for (const item of value) {
    const media = normalizeRelationNode(item);
    if (!media || !isRecord(item)) return undefined;
    const idMal = optionalInteger(item.idMal, 1);
    const description = optionalString(item.description, 100_000);
    const bannerImage = optionalString(item.bannerImage, 2_000);
    const genres = optionalStringArray(item.genres, MAX_GENRES, 100);
    const startDate = normalizeDate(item.startDate);
    const endDate = normalizeDate(item.endDate);
    const episodes = optionalInteger(item.episodes);
    const duration = optionalInteger(item.duration);
    const averageScore = optionalInteger(item.averageScore);
    const popularity = optionalInteger(item.popularity);
    const relations = normalizeRelations(item.relations);
    if (
      [
        idMal, description, bannerImage, genres, startDate, endDate, episodes, duration,
        averageScore, popularity, relations
      ].some((field) => field === INVALID)
    ) {
      return undefined;
    }

    let trailer: AniListSearchResult['trailer'];
    if (item.trailer !== undefined && item.trailer !== null) {
      if (!isRecord(item.trailer)) return undefined;
      const id = optionalString(item.trailer.id, 500);
      const site = optionalString(item.trailer.site, 100);
      const thumbnail = optionalString(item.trailer.thumbnail, 2_000);
      if (typeof id !== 'string' || !id || typeof site !== 'string' || !site || thumbnail === INVALID) {
        return undefined;
      }
      trailer = { id, site };
      if (typeof thumbnail === 'string') trailer.thumbnail = thumbnail;
    }

    let nextAiringEpisode: AniListSearchResult['nextAiringEpisode'];
    if (item.nextAiringEpisode !== undefined && item.nextAiringEpisode !== null) {
      if (!isRecord(item.nextAiringEpisode)) return undefined;
      const episode = optionalInteger(item.nextAiringEpisode.episode, 1);
      const airingAt = optionalInteger(item.nextAiringEpisode.airingAt, 1);
      const timeUntilAiring = optionalInteger(item.nextAiringEpisode.timeUntilAiring);
      if (
        typeof episode !== 'number' ||
        typeof airingAt !== 'number' ||
        typeof timeUntilAiring !== 'number'
      ) {
        return undefined;
      }
      nextAiringEpisode = { episode, airingAt, timeUntilAiring };
    }

    results.set(media.id, {
      ...media,
      ...(typeof idMal === 'number' ? { idMal } : {}),
      ...(typeof description === 'string' ? { description } : {}),
      ...(trailer ? { trailer } : {}),
      ...(typeof bannerImage === 'string' ? { bannerImage } : {}),
      ...(Array.isArray(genres) ? { genres } : {}),
      ...(startDate && startDate !== INVALID ? { startDate } : {}),
      ...(endDate && endDate !== INVALID ? { endDate } : {}),
      ...(typeof episodes === 'number' ? { episodes } : {}),
      ...(typeof duration === 'number' ? { duration } : {}),
      ...(typeof averageScore === 'number' ? { averageScore } : {}),
      ...(typeof popularity === 'number' ? { popularity } : {}),
      ...(nextAiringEpisode ? { nextAiringEpisode } : {}),
      ...(relations && relations !== INVALID ? { relations } : {})
    });
  }
  return [...results.values()];
}

export function normalizeSeasonResponse(value: unknown): AniListSeasonResponse | undefined {
  if (!isRecord(value)) return undefined;
  const season = value.season;
  const year = value.year;
  const valueShows = value.shows;
  if (!validSeason(season) || !validYear(year) || !Array.isArray(valueShows)) return undefined;
  if (valueShows.length > MAX_SEASON_SHOWS) return undefined;
  const ids = new Set<number>();
  const shows: AniListSeasonShow[] = [];
  for (const valueShow of valueShows) {
    const show = normalizeSeasonShow(valueShow);
    if (!show || show.season !== season || show.seasonYear !== year) return undefined;
    if (ids.has(show.id)) continue;
    ids.add(show.id);
    shows.push(show);
  }
  return { season, year, shows };
}

function validProviderSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 160 && /^[a-z0-9-]+$/.test(value);
}

export function normalizeProviderIndex(value: unknown): SubsPleaseIndexResponse | undefined {
  if (!isRecord(value) || !Array.isArray(value.shows) || value.shows.length > MAX_INDEX_SHOWS) {
    return undefined;
  }
  const pages = new Set<string>();
  const shows: SubsPleaseIndexShow[] = [];
  for (const valueShow of value.shows) {
    if (!isRecord(valueShow) || typeof valueShow.title !== 'string' || !validProviderSlug(valueShow.page)) {
      return undefined;
    }
    const title = valueShow.title.trim();
    if (!title || title.length > 500 || pages.has(valueShow.page)) continue;
    pages.add(valueShow.page);
    shows.push({ title, page: valueShow.page });
  }
  return { shows };
}

export function createCatalogCache(options: CatalogCacheOptions = {}) {
  const storage = options.storage ?? storageForBrowser();
  const scope = options.scope ?? 'native';
  const now = options.now ?? Date.now;
  const indexKey = scope === 'native' ? PROVIDER_INDEX_CACHE_KEY : `${PROVIDER_INDEX_CACHE_KEY}.preview`;
  const seasonKey = scope === 'native' ? SEASON_CACHE_KEY : `${SEASON_CACHE_KEY}.preview`;

  function read(key: string): unknown {
    if (!storage) return undefined;
    try {
      return JSON.parse(storage.getItem(key) ?? '');
    } catch {
      return undefined;
    }
  }

  function write(key: string, value: unknown): void {
    if (!storage) return;
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch {
      return;
    }
  }

  function entry<T>(value: unknown, normalize: (data: unknown) => T | undefined): CacheEntry<T> | undefined {
    if (!isRecord(value)) return undefined;
    const savedAt = value.savedAt;
    if (
      typeof savedAt !== 'number' ||
      !Number.isSafeInteger(savedAt) ||
      savedAt < 0 ||
      savedAt > now()
    ) {
      return undefined;
    }
    const data = normalize(value.data);
    return data ? { savedAt, data } : undefined;
  }

  function fresh<T>(value: CacheEntry<T> | undefined, maxAgeMs: number): T | undefined {
    if (
      !value ||
      Number.isNaN(maxAgeMs) ||
      maxAgeMs < 0 ||
      now() - value.savedAt > maxAgeMs
    ) {
      return undefined;
    }
    return value.data;
  }

  function readIndex(): CacheEntry<SubsPleaseIndexResponse> | undefined {
    return entry(read(indexKey), normalizeProviderIndex);
  }

  function readSeason(season: AnimeSeason, year: number): CacheEntry<AniListSeasonResponse> | undefined {
    if (!validSeason(season) || !validYear(year)) return undefined;
    const cache = read(seasonKey);
    if (!isRecord(cache) || !isRecord(cache.entries)) return undefined;
    const cached = entry(cache.entries[`${season}:${year}`], normalizeSeasonResponse);
    return cached?.data.season === season && cached.data.year === year ? cached : undefined;
  }

  return {
    loadIndex(maxAgeMs: number): SubsPleaseIndexResponse | undefined {
      return fresh(readIndex(), maxAgeMs);
    },
    loadStaleIndex(maxAgeMs = Number.POSITIVE_INFINITY): SubsPleaseIndexResponse | undefined {
      return fresh(readIndex(), maxAgeMs);
    },
    saveIndex(value: SubsPleaseIndexResponse): void {
      const normalized = normalizeProviderIndex(value);
      if (normalized) write(indexKey, { savedAt: now(), data: normalized });
    },
    loadSeason(season: AnimeSeason, year: number, maxAgeMs: number): AniListSeasonResponse | undefined {
      return fresh(readSeason(season, year), maxAgeMs);
    },
    loadStaleSeason(
      season: AnimeSeason,
      year: number,
      maxAgeMs = Number.POSITIVE_INFINITY
    ): AniListSeasonResponse | undefined {
      return fresh(readSeason(season, year), maxAgeMs);
    },
    saveSeason(value: AniListSeasonResponse): void {
      const normalized = normalizeSeasonResponse(value);
      if (!normalized) return;
      const cache = read(seasonKey);
      const entries: Record<string, unknown> =
        isRecord(cache) && isRecord(cache.entries) ? { ...cache.entries } : {};
      entries[`${normalized.season}:${normalized.year}`] = { savedAt: now(), data: normalized };
      const retained = Object.fromEntries(
        Object.entries(entries)
          .map(([key, value]) => [key, entry(value, normalizeSeasonResponse)] as const)
          .filter(([, value]) => Boolean(value))
          .sort(([, left], [, right]) => right!.savedAt - left!.savedAt)
          .slice(0, MAX_CACHED_SEASONS)
      );
      write(seasonKey, { entries: retained });
    }
  };
}
