import type { BackendCall } from '$lib/backend';
import type { CatalogCacheOptions } from '$lib/catalog/cache';
import { createCatalogResultCache, type SavedCatalogResult } from '$lib/catalog/result-cache';
import { normalizeMyAnimeListClientId } from '$lib/settings';
import {
  catalogRequestKey, normalizeCatalogProviders, normalizeCatalogResponse, validCatalogRequest,
  type CatalogProvider, type CatalogProvenance, type CatalogRequest
} from '$lib/catalog/providers';
import { currentSeason, seasonOrdinal } from '$lib/catalog/presentation';
import { errorMessage } from '$lib/errors';

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
  const failures = new Map<string, { until: number; label: string; message: string }>();
  const pending = new Map<string, Promise<CatalogResult>>();
  let registry: Promise<CatalogProvider[]> | undefined;
  let myAnimeListClientId: string | undefined;
  let myAnimeListConfiguration = 0;

  function providers(): Promise<CatalogProvider[]> {
    if (!registry) {
      registry = Promise.resolve().then(() => call('catalog_providers')).then((value) => {
        const normalized = normalizeCatalogProviders(value);
        if (!normalized) throw new Error('The catalog provider registry is invalid.');
        return normalized;
      }).catch((error: unknown) => { registry = undefined; throw error; });
    }
    return registry;
  }

  function freshAge(request: CatalogRequest): number {
    if (request.kind === 'search' || request.kind === 'recommendations') return 5 * MINUTE;
    const current = currentSeason(new Date(now()));
    const delta = seasonOrdinal(request.season, request.year) - seasonOrdinal(current.season, current.year);
    return delta === 0 ? 15 * MINUTE : delta < 0 ? 7 * DAY : 60 * MINUTE;
  }

  function result(
    saved: SavedCatalogResult,
    provider: CatalogProvider,
    mode: CatalogProvenance['cache'],
    errors: Array<{ label: string; message: string }>,
    secondary: boolean
  ): CatalogResult {
    const warnings = [...saved.data.warnings];
    if (errors.length) warnings.unshift(`Catalog refresh failed: ${errors.map(({ message }) => message.replace(/[.!?]+$/, '')).join('; ')}.`);
    if (mode === 'stale') warnings.push('Showing saved catalog data.');
    else if (secondary) warnings.push(`Using ${provider.label} as an alternative catalog source; coverage may differ.`);
    const failedProviders = [...new Set(errors.map(({ label }) => label))];
    return {
      ...saved,
      provenance: {
        provider: provider.id,
        label: provider.label,
        fetchedAt: saved.savedAt,
        cache: mode,
        ...(failedProviders.length ? { failedProviders } : {})
      },
      ...(warnings.length ? { cacheWarning: warnings.join(' ') } : {})
    };
  }

  function orderProviders(available: CatalogProvider[], providerOrder: readonly string[]): CatalogProvider[] {
    if (!providerOrder.length) return available;
    const selected = [...new Set(providerOrder)];
    const byId = new Map(available.map((provider) => [provider.id, provider]));
    return [
      ...selected.map((provider) => byId.get(provider)).filter((provider): provider is CatalogProvider => Boolean(provider)),
      ...available.filter((provider) => !selected.includes(provider.id))
    ];
  }

  async function resolve(
    request: CatalogRequest,
    providerOrder: readonly string[],
    currentMyAnimeListClientId: string | undefined,
    configuration: number
  ): Promise<CatalogResult> {
    const available = orderProviders(
      (await providers()).filter((provider) =>
        provider.capabilities.includes(request.kind)
          && (provider.id !== 'myanimelist' || Boolean(currentMyAnimeListClientId))),
      providerOrder
    );
    if (!available.length) throw new Error(`No catalog provider supports ${request.kind}.`);
    const errors: Array<{ label: string; message: string }> = [];
    for (const [index, provider] of available.entries()) {
      const secondary = index > 0;
      const age = secondary ? Math.min(freshAge(request), FALLBACK_MAX_FRESH_AGE) : freshAge(request);
      const fresh = cache.load(provider.id, request, age);
      if (fresh) return result(fresh, provider, 'fresh', errors, secondary);
      const failure = provider.id !== 'myanimelist' || configuration === myAnimeListConfiguration
        ? failures.get(provider.id) : undefined;
      if (failure && failure.until > now()) {
        errors.push(failure);
      } else {
        try {
          const raw = await call('catalog_request', {
            provider: provider.id,
            request,
            ...(provider.id === 'myanimelist'
              ? { myAnimeListClientId: currentMyAnimeListClientId }
              : {})
          });
          const value = normalizeCatalogResponse(raw, provider.id, request);
          if (!value) throw new Error('Invalid catalog response.');
          if (provider.id !== 'myanimelist' || configuration === myAnimeListConfiguration) {
            failures.delete(provider.id);
          }
          return result(cache.save(request, value), provider, 'none', errors, secondary);
        } catch (reason: unknown) {
          const message = `${provider.label}: ${errorMessage(reason)}`;
          const failed = { until: now() + FAILURE_COOLDOWN, label: provider.label, message };
          if (provider.id !== 'myanimelist' || configuration === myAnimeListConfiguration) {
            failures.set(provider.id, failed);
          }
          errors.push(failed);
        }
      }
      const stale = cache.load(
        provider.id,
        request,
        request.kind === 'season' ? 90 * DAY : 30 * DAY
      );
      if (stale) return result(stale, provider, 'stale', errors, secondary);
    }
    throw new Error(`Catalog providers are unavailable. ${errors.map(({ message }) => message).join(' ')}`);
  }

  return {
    load(
      request: CatalogRequest,
      providerOrder: readonly string[] = [],
      configuredMyAnimeListClientId?: string
    ): Promise<CatalogResult> {
      if (!validCatalogRequest(request)) return Promise.reject(new Error('Invalid catalog request.'));
      const currentMyAnimeListClientId = normalizeMyAnimeListClientId(configuredMyAnimeListClientId);
      if (currentMyAnimeListClientId !== myAnimeListClientId) {
        myAnimeListClientId = currentMyAnimeListClientId;
        myAnimeListConfiguration += 1;
        failures.delete('myanimelist');
      }
      const key = `${catalogRequestKey(request)}\u0000${JSON.stringify(providerOrder)}\u0000mal:${myAnimeListConfiguration}`;
      const existing = pending.get(key);
      if (existing) return existing;
      const promise = resolve(request, providerOrder, currentMyAnimeListClientId, myAnimeListConfiguration).finally(() => {
        if (pending.get(key) === promise) pending.delete(key);
      });
      pending.set(key, promise);
      return promise;
    }
  };
}
