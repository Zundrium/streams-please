import { callBackend, isTauri, type BackendCall } from '$lib/backend';
import {
  loadSettings,
  normalizeCatalogProviderOrder,
  normalizeMyAnimeListClientId
} from '$lib/settings';
import {
  createCatalogCache,
  normalizeProviderIndex,
  type CatalogCacheScope,
  type CatalogStorage
} from '$lib/catalog/cache';
import type {
  AnimeSeason,
  AniListSeasonResponse,
  SubsPleaseIndexResponse,
  SubsPleaseScheduleResponse,
  SubsPleaseShowResponse
} from '$lib/types';

import { createCatalogCoordinator } from '$lib/catalog/coordinator';
import { seasonItems, type CatalogSearchResponse } from '$lib/catalog/providers';
const DEFAULT_MAX_CONCURRENT_REQUESTS = 4;
const DEFAULT_MAX_ENTRIES = 100;
const MAX_STALE_INDEX_AGE = 30 * 24 * 60 * 60 * 1000;

export interface CatalogClientOptions {
  cacheScope?: CatalogCacheScope;
  storage?: CatalogStorage;
  now?: () => number;
  maxConcurrentRequests?: number;
  maxEntries?: number;
  providerOrder?: () => readonly string[];
  myAnimeListClientId?: () => string | undefined;
}

interface RequestEntry<T> {
  promise: Promise<T>;
  expiresAt: number;
  touchedAt: number;
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
  const coordinator = createCatalogCoordinator(call, {
    scope: options.cacheScope ?? cacheScope(), storage: options.storage, now
  });
  const requests = new Map<string, RequestEntry<unknown>>();
  const maxConcurrent = boundedOption(
    options.maxConcurrentRequests,
    DEFAULT_MAX_CONCURRENT_REQUESTS,
    16
  );
  const maxEntries = boundedOption(options.maxEntries, DEFAULT_MAX_ENTRIES, 200);
  const providerOrder = options.providerOrder ?? (() => loadSettings().catalogProviderOrder);
  const configuredMyAnimeListClientId = options.myAnimeListClientId
    ?? (() => loadSettings().myAnimeListClientId);
  let activeRequests = 0;
  let lastMyAnimeListClientId: string | undefined;
  let myAnimeListConfiguration = 0;
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

  function catalogConfiguration(): { myAnimeListClientId: string | undefined; generation: number } {
    const myAnimeListClientId = normalizeMyAnimeListClientId(configuredMyAnimeListClientId());
    if (myAnimeListClientId !== lastMyAnimeListClientId) {
      lastMyAnimeListClientId = myAnimeListClientId;
      myAnimeListConfiguration += 1;
    }
    return { myAnimeListClientId, generation: myAnimeListConfiguration };
  }

  function recommendationIds(ids: number[]): number[] | undefined {
    if (ids.length < 1 || ids.length > 10
      || ids.some((id) => !Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647)) return undefined;
    return [...new Set(ids)].sort((left, right) => left - right);
  }

  return {
    loadSearch(query: string): Promise<CatalogSearchResponse> {
      const order = normalizeCatalogProviderOrder(providerOrder());
      const configuration = catalogConfiguration();
      return request(
        `search:${normalizedKey(query)}:providers:${JSON.stringify(order)}:mal:${configuration.generation}`,
        0,
        async () => {
          const response = await coordinator.load({ kind: 'search', query }, order, configuration.myAnimeListClientId);
          return { results: response.data.items, provenance: response.provenance, cacheWarning: response.cacheWarning };
        }
      );
    },
    loadSeason(season: AnimeSeason, year: number): Promise<AniListSeasonResponse> {
      const order = normalizeCatalogProviderOrder(providerOrder());
      const configuration = catalogConfiguration();
      return request(
        `season:${season}:${year}:providers:${JSON.stringify(order)}:mal:${configuration.generation}`,
        0,
        async () => {
          const response = await coordinator.load({ kind: 'season', season, year }, order, configuration.myAnimeListClientId);
          return {
            season, year, shows: seasonItems(response.data),
            provenance: response.provenance, cacheWarning: response.cacheWarning
          };
        }
      );
    },
    loadRecommendations(ids: number[]): Promise<CatalogSearchResponse> {
      const normalizedIds = recommendationIds(ids);
      if (!normalizedIds) return Promise.reject(new Error('Invalid recommendation seeds.'));
      const order = normalizeCatalogProviderOrder(providerOrder());
      const configuration = catalogConfiguration();
      return request(
        `recommendations:${normalizedIds.join(',')}:providers:${JSON.stringify(order)}:mal:${configuration.generation}`,
        0,
        async () => {
          const response = await coordinator.load(
            { kind: 'recommendations', ids: normalizedIds },
            order,
            configuration.myAnimeListClientId
          );
          return { results: response.data.items, provenance: response.provenance, cacheWarning: response.cacheWarning };
        }
      );
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
