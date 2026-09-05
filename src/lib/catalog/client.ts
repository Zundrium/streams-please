import { callBackend, isTauri, type BackendCall } from '$lib/backend';
import {
  createCatalogCache,
  normalizeProviderIndex,
  normalizeSearchResponse,
  normalizeSeasonResponse,
  type CatalogCacheScope,
  type CatalogStorage
} from '$lib/catalog/cache';
import type {
  AnimeSeason,
  AniListSearchResult,
  AniListSeasonResponse,
  SubsPleaseIndexResponse,
  SubsPleaseScheduleResponse,
  SubsPleaseShowResponse
} from '$lib/types';

import { currentSeason, SEASON_ORDER } from '$lib/catalog/presentation';
const DEFAULT_MAX_CONCURRENT_REQUESTS = 4;
const DEFAULT_MAX_ENTRIES = 100;
const MAX_STALE_INDEX_AGE = 30 * 24 * 60 * 60 * 1000;
const MAX_STALE_SEASON_AGE = 90 * 24 * 60 * 60 * 1000;

export interface CatalogClientOptions {
  cacheScope?: CatalogCacheScope;
  storage?: CatalogStorage;
  now?: () => number;
  maxConcurrentRequests?: number;
  maxEntries?: number;
}

interface RequestEntry<T> {
  promise: Promise<T>;
  expiresAt: number;
  touchedAt: number;
}

function seasonCacheMaxAge(season: AnimeSeason, year: number, now: () => number): number {
  const current = currentSeason(new Date(now()));
  const requestedIndex = year * 4 + SEASON_ORDER.indexOf(season);
  const currentIndex = current.year * 4 + SEASON_ORDER.indexOf(current.season);
  if (requestedIndex === currentIndex) return 15 * 60 * 1000;
  return requestedIndex < currentIndex ? 7 * 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
}

function normalizedKey(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function cacheScope(): CatalogCacheScope {
  return isTauri() ? 'native' : 'preview';
}

function boundedOption(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

export function createCatalogClient(
  call: BackendCall = callBackend,
  options: CatalogClientOptions = {}
) {
  const now = options.now ?? Date.now;
  const cache = createCatalogCache({
    scope: options.cacheScope ?? cacheScope(),
    storage: options.storage,
    now
  });
  const requests = new Map<string, RequestEntry<unknown>>();
  const maxConcurrent = boundedOption(
    options.maxConcurrentRequests,
    DEFAULT_MAX_CONCURRENT_REQUESTS,
    16
  );
  const maxEntries = boundedOption(options.maxEntries, DEFAULT_MAX_ENTRIES, 200);
  let activeRequests = 0;
  const queued: Array<() => void> = [];

  function run<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        activeRequests += 1;
        void Promise.resolve().then(operation).then(resolve, reject).finally(() => {
          activeRequests -= 1;
          queued.shift()?.();
        });
      };
      if (activeRequests < maxConcurrent) start();
      else queued.push(start);
    });
  }

  function trim(): void {
    if (requests.size <= maxEntries) return;
    const removable = [...requests.entries()]
      .filter(([, entry]) => entry.expiresAt !== Number.POSITIVE_INFINITY)
      .sort(([, left], [, right]) => left.touchedAt - right.touchedAt);
    while (requests.size > maxEntries && removable.length) requests.delete(removable.shift()![0]);
  }

  function request<T>(key: string, ttlMs: number, operation: () => Promise<T>): Promise<T> {
    const requestedAt = now();
    const existing = requests.get(key) as RequestEntry<T> | undefined;
    if (existing && existing.expiresAt > requestedAt) {
      existing.touchedAt = requestedAt;
      return existing.promise;
    }
    if (existing) requests.delete(key);

    const entry: RequestEntry<T> = {
      promise: Promise.resolve(undefined as T),
      expiresAt: Number.POSITIVE_INFINITY,
      touchedAt: requestedAt
    };
    const promise = run(operation).then(
      (value) => {
        entry.expiresAt = now() + ttlMs;
        entry.touchedAt = now();
        trim();
        return value;
      },
      (reason: unknown) => {
        if (requests.get(key) === entry) requests.delete(key);
        throw reason;
      }
    );
    entry.promise = promise;
    requests.set(key, entry as RequestEntry<unknown>);
    trim();
    return promise;
  }

  function fallback<T extends { cacheWarning?: string }>(value: T | undefined, reason: unknown): T {
    if (value === undefined) throw reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    return {
      ...value,
      cacheWarning: `Catalog refresh failed: ${message}. Showing saved catalog data.`
    };
  }

  return {
    loadSearch(query: string): Promise<AniListSearchResult[]> {
      const normalized = normalizedKey(query);
      return request(`search:${normalized}`, 5 * 60 * 1000, async () => {
        const response = normalizeSearchResponse(await call<unknown>('anilist_search', { query }));
        if (!response) throw new Error('AniList returned invalid search results. Try again later.');
        return response;
      });
    },
    loadSeason(season: AnimeSeason, year: number): Promise<AniListSeasonResponse> {
      const key = `season:${season}:${year}`;
      const maxAge = seasonCacheMaxAge(season, year, now);
      const fresh = cache.loadSeason(season, year, maxAge);
      if (fresh) return Promise.resolve(fresh);
      const stale = cache.loadStaleSeason(season, year, MAX_STALE_SEASON_AGE);
      return request(key, maxAge, async () => {
        const response = normalizeSeasonResponse(await call<unknown>('anilist_season', { season, year }));
        if (!response || response.season !== season || response.year !== year) {
          throw new Error('AniList returned invalid season data. Try again later.');
        }
        cache.saveSeason(response);
        return response;
      }).catch((reason: unknown) => fallback(stale, reason));
    },
    loadIndex(): Promise<SubsPleaseIndexResponse> {
      const key = 'index';
      const maxAge = 24 * 60 * 60 * 1000;
      const fresh = cache.loadIndex(maxAge);
      if (fresh) return Promise.resolve(fresh);
      const stale = cache.loadStaleIndex(MAX_STALE_INDEX_AGE);
      return request(key, maxAge, async () => {
        const response = normalizeProviderIndex(await call<unknown>('subsplease_index'));
        if (!response) throw new Error('SubsPlease returned an invalid archive. Try again later.');
        cache.saveIndex(response);
        return response;
      }).catch((reason: unknown) => fallback(stale, reason));
    },
    loadSchedule(timezone: string): Promise<SubsPleaseScheduleResponse> {
      const normalized = normalizedKey(timezone);
      return request(`schedule:${normalized}`, 5 * 60 * 1000, () =>
        call<SubsPleaseScheduleResponse>('subsplease_schedule', { timezone })
      );
    },
    loadShow(
      slug: string,
      timezone: string,
      anilistId?: number,
      includeMetadata = true
    ): Promise<SubsPleaseShowResponse> {
      const key = [
        'show',
        normalizedKey(slug),
        normalizedKey(timezone),
        anilistId ?? 'none',
        includeMetadata ? 'metadata' : 'provider'
      ].join(':');
      return request(key, 5 * 60 * 1000, () =>
        call<SubsPleaseShowResponse>('subsplease_show', {
          slug,
          timezone,
          anilistId,
          includeMetadata
        })
      );
    }
  };
}

export type CatalogClient = ReturnType<typeof createCatalogClient>;
