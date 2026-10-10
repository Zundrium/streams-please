import type { AnimeSeason, CatalogMedia, CatalogSeasonMedia } from '$lib/types';
import { normalizeSearchResponse, normalizeSeasonResponse } from '$lib/catalog/cache';
import { isRecord } from '$lib/catalog/guards';

export type CatalogCapability = 'search' | 'season' | 'recommendations';
export type CatalogRequest =
  | { kind: 'search'; query: string }
  | { kind: 'season'; season: AnimeSeason; year: number }
  | { kind: 'recommendations'; ids: number[] };

export interface CatalogProvider {
  id: string;
  label: string;
  capabilities: CatalogCapability[];
}

export interface CatalogProviderResponse {
  provider: string;
  items: CatalogMedia[];
  warnings: string[];
  season?: AnimeSeason;
  year?: number;
}

export interface CatalogProvenance {
  provider: string;
  label: string;
  fetchedAt: number;
  cache: 'none' | 'fresh' | 'stale';
  failedProviders?: string[];
}

export interface CatalogSearchResponse {
  results: CatalogMedia[];
  provenance?: CatalogProvenance;
  cacheWarning?: string;
}

export function catalogRequestKey(request: CatalogRequest): string {
  if (request.kind === 'search') return `search:${request.query.trim().toLocaleLowerCase()}`;
  if (request.kind === 'season') return `season:${request.season}:${request.year}`;
  return `recommendations:${[...new Set(request.ids)].sort((left, right) => left - right).join(',')}`;
}

export function validSearchQuery(query: string): boolean {
  const trimmed = query.trim();
  const length = new TextEncoder().encode(trimmed).length;
  return length >= 2 && length <= 160 && !/[\u0000-\u001f\u007f-\u009f]/.test(trimmed);
}

export function validCatalogRequest(request: CatalogRequest): boolean {
  if (request.kind === 'search') return validSearchQuery(request.query);
  if (request.kind === 'season') {
    return ['WINTER', 'SPRING', 'SUMMER', 'FALL'].includes(request.season)
      && Number.isSafeInteger(request.year) && request.year >= 1940 && request.year <= 2200;
  }
  return Array.isArray(request.ids)
    && request.ids.length >= 1
    && request.ids.length <= 10
    && new Set(request.ids).size === request.ids.length
    && request.ids.every((id) => Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647);
}

export function normalizeCatalogProviders(value: unknown): CatalogProvider[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 20) return undefined;
  const providers: CatalogProvider[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(item.id)
      || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 100
      || providers.some((provider) => provider.id === item.id)
      || !Array.isArray(item.capabilities) || item.capabilities.length > 20
      || !item.capabilities.every((capability) => typeof capability === 'string')) return undefined;
    providers.push({
      id: item.id,
      label: item.label,
      capabilities: item.capabilities.filter((capability): capability is CatalogCapability =>
        capability === 'search' || capability === 'season' || capability === 'recommendations')
    });
  }
  return providers;
}

export function normalizeCatalogResponse(
  value: unknown,
  provider: string,
  request: CatalogRequest
): CatalogProviderResponse | undefined {
  if (!isRecord(value) || value.provider !== provider || !Array.isArray(value.warnings)
    || value.warnings.length > 20
    || !value.warnings.every((warning) => typeof warning === 'string' && warning.length <= 4_000)) return undefined;
  if (request.kind === 'season') {
    const season = normalizeSeasonResponse({ season: value.season, year: value.year, shows: value.items });
    if (!season || season.season !== request.season || season.year !== request.year) return undefined;
    return { provider, items: season.shows, season: season.season, year: season.year, warnings: [...value.warnings] };
  }
  const items = normalizeSearchResponse(value.items);
  if (!items || value.season !== undefined || value.year !== undefined) return undefined;
  return { provider, items, warnings: [...value.warnings] };
}

export function seasonItems(response: CatalogProviderResponse): CatalogSeasonMedia[] {
  return response.items.filter((item): item is CatalogSeasonMedia =>
    item.season === response.season && item.seasonYear === response.year
      && item.season !== undefined && item.seasonYear !== undefined);
}

export function catalogSourceLabel(provenance: CatalogProvenance | undefined, now = Date.now()): string {
  if (!provenance) return '';
  if (provenance.cache === 'none') return provenance.label;
  const minutes = Math.max(0, Math.floor((now - provenance.fetchedAt) / 60_000));
  const age = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago`
    : minutes < 1_440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1_440)}d ago`;
  return `${provenance.label} · ${provenance.cache === 'stale' ? 'saved' : 'cached'} ${age}`;
}
