import { errorMessage } from '$lib/catalog/presentation';
import { loadProviderMappings, matchSubsPleaseSeason, searchArchive } from '$lib/catalog/matching';
import type { CatalogMedia, SubsPleaseIndexResponse } from '$lib/types';
import type { CatalogProvenance, CatalogSearchResponse } from '$lib/catalog/providers';

export function createCatalogSearch(
  loadSearch: (query: string) => Promise<CatalogSearchResponse>,
  loadIndex: () => Promise<SubsPleaseIndexResponse>
) {
  let query = $state('');
  let results = $state<CatalogMedia[]>([]);
  let provenance = $state<CatalogProvenance | undefined>();
  let cacheWarning = $state('');
  let providerIndex = $state<SubsPleaseIndexResponse | null>(null);
  let animeLoading = $state(false);
  let providerLoading = $state(false);
  let searchError = $state('');
  let providerError = $state('');
  let generation = 0;
  let disposed = false;

  const verifiedResults = $derived.by(() => {
    const matches = matchSubsPleaseSeason(results, providerIndex?.shows ?? [], loadProviderMappings());
    return results.map((anime) => ({ anime, match: matches.get(anime.id) }));
  });
  const archiveResults = $derived(searchArchive(query, providerIndex?.shows ?? []));

  async function search(value: string): Promise<void> {
    if (disposed) return;
    const id = ++generation;
    query = value.trim();
    results = [];
    provenance = undefined;
    cacheWarning = '';
    searchError = '';
    providerError = '';
    animeLoading = false;
    providerLoading = false;
    if (query.length < 2 || query.length > 160 || /[\u0000-\u001f\u007f]/.test(query)) {
      searchError = 'Enter between 2 and 160 characters.';
      return;
    }
    const term = query;
    const current = () => !disposed && id === generation;
    animeLoading = true;
    providerLoading = true;
    await Promise.all([
      Promise.resolve().then(() => loadSearch(term)).then(
        (value) => {
          if (!current()) return;
          results = value.results;
          provenance = value.provenance;
          cacheWarning = value.cacheWarning ?? '';
        },
        (reason: unknown) => { if (current()) searchError = errorMessage(reason); }
      ).finally(() => { if (current()) animeLoading = false; }),
      Promise.resolve().then(loadIndex).then(
        (value) => { if (current()) providerIndex = value; },
        (reason: unknown) => { if (current()) providerError = errorMessage(reason); }
      ).finally(() => { if (current()) providerLoading = false; })
    ]);
  }

  function clear(): void {
    generation += 1;
    query = '';
    results = [];
    provenance = undefined;
    cacheWarning = '';
    searchError = '';
    providerError = '';
    animeLoading = false;
    providerLoading = false;
  }

  return {
    get query() { return query; },
    get results() { return results; },
    get provenance() { return provenance; },
    get cacheWarning() { return cacheWarning; },
    get verifiedResults() { return verifiedResults; },
    get archiveResults() { return archiveResults; },
    get providerIndex() { return providerIndex; },
    get animeLoading() { return animeLoading; },
    get providerLoading() { return providerLoading; },
    get searchError() { return searchError; },
    get providerError() { return providerError; },
    search,
    clear,
    dispose() { disposed = true; generation += 1; }
  };
}
