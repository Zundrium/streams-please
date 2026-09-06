import { errorMessage } from '$lib/catalog/presentation';
import { recommendationSeedIds } from '$lib/discovery/recommendations';
import type { CatalogSearchResponse } from '$lib/catalog/providers';
import type { LibraryEntry } from '$lib/types';

export function createRecommendationDiscovery(
  loadRecommendations: (ids: number[]) => Promise<CatalogSearchResponse>
) {
  let active = $state(false);
  let seedIds = $state<number[]>([]);
  let catalog = $state<CatalogSearchResponse | null>(null);
  let loading = $state(false);
  let error = $state('');
  let generation = 0;
  let disposed = false;

  async function refresh(entries: LibraryEntry[]): Promise<CatalogSearchResponse | null> {
    if (disposed || !active) return null;
    const requestGeneration = ++generation;
    const seeds = recommendationSeedIds(entries);
    seedIds = seeds;
    catalog = null;
    error = '';
    loading = seeds.length > 0;
    if (!seeds.length) return null;

    try {
      const response = await loadRecommendations([...seeds]);
      if (disposed || !active || requestGeneration !== generation) return null;
      catalog = response;
      return response;
    } catch (reason) {
      if (!disposed && active && requestGeneration === generation) {
        error = errorMessage(reason);
      }
      return null;
    } finally {
      if (!disposed && active && requestGeneration === generation) loading = false;
    }
  }

  function enter(entries: LibraryEntry[]): Promise<CatalogSearchResponse | null> {
    if (disposed || active) return Promise.resolve(catalog);
    active = true;
    return refresh(entries);
  }

  function leave(): void {
    if (!active) return;
    active = false;
    generation += 1;
    seedIds = [];
    catalog = null;
    loading = false;
    error = '';
  }

  return {
    get active() { return active; },
    get seedIds() { return seedIds; },
    get catalog() { return catalog; },
    get loading() { return loading; },
    get error() { return error; },
    enter,
    refresh,
    leave,
    dispose() {
      if (disposed) return;
      leave();
      disposed = true;
      generation += 1;
    }
  };
}
