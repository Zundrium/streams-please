import { normalizeSeasonResponse, type CatalogCacheOptions, type CatalogStorage } from '$lib/catalog/cache';
import { isRecord } from '$lib/catalog/guards';
import {
  catalogRequestKey, normalizeCatalogResponse, validCatalogRequest,
  type CatalogProviderResponse, type CatalogRequest
} from '$lib/catalog/providers';

const CACHE_KEY = 'streamsplease.catalog-results.v1';
const MAX_ENTRIES = 48;
const LEGACY_SEASON_KEY = 'streamsplease.season-cache.v1';
const MAX_CACHE_BYTES = 1_500_000;

export interface SavedCatalogResult {
  savedAt: number;
  data: CatalogProviderResponse;
}

interface StoredResult extends SavedCatalogResult {
  request: CatalogRequest;
}

function browserStorage(): CatalogStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; }
  catch { return undefined; }
}

export function createCatalogResultCache(options: CatalogCacheOptions = {}) {
  const storage = options.storage ?? browserStorage();
  const now = options.now ?? Date.now;
  const suffix = options.scope === 'preview' ? '.preview' : '';
  const key = `${CACHE_KEY}${suffix}`;
  let memory = new Map<string, StoredResult>();

  function parse(key: string): unknown {
    try {
      const raw = storage?.getItem(key);
      return raw && raw.length <= MAX_CACHE_BYTES ? JSON.parse(raw) : undefined;
    } catch { return undefined; }
  }

  function timestamp(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= now();
  }

  function entryKey(provider: string, request: CatalogRequest): string {
    return `${provider}:${catalogRequestKey(request)}`;
  }

  function loadStored(): void {
    const stored = parse(key);
    if (!Array.isArray(stored) || stored.length > MAX_ENTRIES) return;
    for (const item of stored) {
      if (!isRecord(item) || !timestamp(item.savedAt) || !isRecord(item.request) || !isRecord(item.data)) continue;
      const request = item.request as unknown as CatalogRequest;
      if ((request.kind !== 'search' && request.kind !== 'season' && request.kind !== 'recommendations')
        || (request.kind === 'search' && typeof request.query !== 'string')
        || (request.kind === 'recommendations' && !Array.isArray(request.ids))
        || !validCatalogRequest(request) || typeof item.data.provider !== 'string'
        || !/^[a-z0-9-]{1,32}$/.test(item.data.provider)) continue;
      const data = normalizeCatalogResponse(item.data, item.data.provider, request);
      if (data) memory.set(entryKey(data.provider, request), { savedAt: item.savedAt, data, request });
    }
  }

  function persist(): boolean {
    const retained = [...memory.entries()].sort(([, a], [, b]) => b.savedAt - a.savedAt).slice(0, MAX_ENTRIES);
    let serialized = JSON.stringify(retained.map(([, entry]) => entry));
    while (serialized.length > MAX_CACHE_BYTES && retained.length) {
      retained.pop();
      serialized = JSON.stringify(retained.map(([, entry]) => entry));
    }
    memory = new Map(retained);
    try { storage?.setItem(key, serialized); return true; } catch { return false; }
  }

  function migrateLegacySeasons(): void {
    const legacyKey = `${LEGACY_SEASON_KEY}${suffix}`;
    const stored = parse(legacyKey);
    if (isRecord(stored) && isRecord(stored.entries)) {
      for (const [name, value] of Object.entries(stored.entries)) {
        if (!isRecord(value) || !timestamp(value.savedAt)) continue;
        const season = normalizeSeasonResponse(value.data);
        if (!season || name !== `${season.season}:${season.year}`) continue;
        const request: CatalogRequest = { kind: 'season', season: season.season, year: season.year };
        const entry = entryKey('anilist', request);
        if (memory.has(entry)) continue;
        memory.set(entry, {
          savedAt: value.savedAt,
          data: { provider: 'anilist', items: season.shows, season: season.season, year: season.year, warnings: [] },
          request
        });
      }
    }
    if (!storage?.removeItem || storage.getItem(legacyKey) === null) return;
    if (persist()) {
      try { storage.removeItem(legacyKey); } catch {}
    }
  }

  loadStored();
  migrateLegacySeasons();

  return {
    load(provider: string, request: CatalogRequest, maxAge: number): SavedCatalogResult | undefined {
      if (!validCatalogRequest(request) || !Number.isFinite(maxAge) || maxAge < 0) return undefined;
      const value = memory.get(entryKey(provider, request));
      if (!value || now() < value.savedAt || now() - value.savedAt > maxAge) return undefined;
      return { savedAt: value.savedAt, data: structuredClone(value.data) };
    },
    save(request: CatalogRequest, value: CatalogProviderResponse): SavedCatalogResult {
      const data = normalizeCatalogResponse(value, value.provider, request);
      if (!validCatalogRequest(request) || !data) throw new Error('Cannot cache invalid catalog data.');
      const savedAt = now();
      memory.set(entryKey(data.provider, request), {
        savedAt,
        data: structuredClone(data),
        request: request.kind === 'recommendations' ? { ...request, ids: [...request.ids] } : { ...request }
      });
      persist();
      return { savedAt, data };
    }
  };
}
