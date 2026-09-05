import type { BackendCall } from '$lib/backend';
import type { CatalogCacheOptions } from '$lib/catalog/cache';
import { createCatalogResultCache, type SavedCatalogResult } from '$lib/catalog/result-cache';
import {
  catalogRequestKey, normalizeCatalogProviders, normalizeCatalogResponse, validCatalogRequest,
  type CatalogProvider, type CatalogProvenance, type CatalogRequest
} from '$lib/catalog/providers';
import { currentSeason, SEASON_ORDER } from '$lib/catalog/presentation';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const FAILURE_COOLDOWN = MINUTE;
const FALLBACK_MAX_FRESH_AGE = 5 * MINUTE;

interface CatalogResult extends SavedCatalogResult {
  provenance: CatalogProvenance;
  cacheWarning?: string;
}

export function createCatalogCoordinator(call: BackendCall, options: CatalogCacheOptions = {}) {
  const now = options.now ?? Date.now;
  const cache = createCatalogResultCache(options);
  const failures = new Map<string, { until: number; message: string }>();
  const pending = new Map<string, Promise<CatalogResult>>();
  let registry: Promise<CatalogProvider[]> | undefined;

  function providers(): Promise<CatalogProvider[]> {
    if (!registry) {
      registry = Promise.resolve().then(() => call<unknown>('catalog_providers')).then((value) => {
        const normalized = normalizeCatalogProviders(value);
        if (!normalized) throw new Error('The catalog provider registry is invalid.');
        return normalized;
      }).catch((error: unknown) => { registry = undefined; throw error; });
    }
    return registry;
  }

  function freshAge(request: CatalogRequest): number {
    if (request.kind === 'search') return 5 * MINUTE;
    const current = currentSeason(new Date(now()));
    const delta = request.year * 4 + SEASON_ORDER.indexOf(request.season)
      - (current.year * 4 + SEASON_ORDER.indexOf(current.season));
    return delta === 0 ? 15 * MINUTE : delta < 0 ? 7 * DAY : 60 * MINUTE;
  }

  function result(
    saved: SavedCatalogResult,
    provider: CatalogProvider,
    mode: CatalogProvenance['cache'],
    errors: string[],
    secondary: boolean
  ): CatalogResult {
    const warnings = [...saved.data.warnings];
    if (errors.length) warnings.unshift(`Catalog refresh failed: ${errors.map((error) => error.replace(/[.!?]+$/, '')).join('; ')}.`);
    if (mode === 'stale') warnings.push('Showing saved catalog data.');
    else if (secondary) warnings.push(`Using ${provider.label} as an alternative catalog source; coverage may differ.`);
    return {
      ...saved,
      provenance: { provider: provider.id, label: provider.label, fetchedAt: saved.savedAt, cache: mode },
      ...(warnings.length ? { cacheWarning: warnings.join(' ') } : {})
    };
  }

  async function resolve(request: CatalogRequest): Promise<CatalogResult> {
    const available = (await providers()).filter((provider) => provider.capabilities.includes(request.kind));
    if (!available.length) throw new Error(`No catalog provider supports ${request.kind}.`);
    const errors: string[] = [];
    for (const [index, provider] of available.entries()) {
      const secondary = index > 0;
      const age = secondary ? Math.min(freshAge(request), FALLBACK_MAX_FRESH_AGE) : freshAge(request);
      const fresh = cache.load(provider.id, request, age);
      if (fresh) return result(fresh, provider, 'fresh', errors, secondary);
      const failure = failures.get(provider.id);
      if (failure && failure.until > now()) {
        errors.push(failure.message);
      } else {
        try {
          const raw = await call<unknown>('catalog_request', { provider: provider.id, request });
          const value = normalizeCatalogResponse(raw, provider.id, request);
          if (!value) throw new Error('Invalid catalog response.');
          failures.delete(provider.id);
          return result(cache.save(request, value), provider, 'none', errors, secondary);
        } catch (reason: unknown) {
          const message = `${provider.label}: ${reason instanceof Error ? reason.message : String(reason)}`;
          failures.set(provider.id, { until: now() + FAILURE_COOLDOWN, message });
          errors.push(message);
        }
      }
      const stale = cache.load(provider.id, request, request.kind === 'search' ? 30 * DAY : 90 * DAY);
      if (stale) return result(stale, provider, 'stale', errors, secondary);
    }
    throw new Error(`Catalog providers are unavailable. ${errors.join(' ')}`);
  }

  return {
    load(request: CatalogRequest): Promise<CatalogResult> {
      if (!validCatalogRequest(request)) return Promise.reject(new Error('Invalid catalog request.'));
      const key = catalogRequestKey(request);
      const existing = pending.get(key);
      if (existing) return existing;
      const promise = resolve(request).finally(() => {
        if (pending.get(key) === promise) pending.delete(key);
      });
      pending.set(key, promise);
      return promise;
    }
  };
}
