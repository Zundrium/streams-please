<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Search, X } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { InputGroup, InputGroupAddon, InputGroupInput } from '$lib/components/ui/input-group';
  import ContextToolbar from '$lib/components/shared/ContextToolbar.svelte';
  import ShowDetailsPage from '$lib/components/catalog/ShowDetailsPage.svelte';
  import CatalogLoading from '$lib/components/catalog/CatalogLoading.svelte';
  import CatalogNotice from '$lib/components/catalog/CatalogNotice.svelte';
  import SearchResultCard from '$lib/components/catalog/SearchResultCard.svelte';
  import {
    CONFIRMED_MATCH_CONFIDENCE, errorMessage, preferredTitle, providerImageUrl,
    matchSubsPleaseShow, saveProviderMapping, type ProviderMatch
  } from '$lib/catalog';
  import { createCatalogSearch } from '$lib/catalog/search.svelte';
  import { catalogSourceLabel, type CatalogSearchResponse } from '$lib/catalog/providers';
  import type { CatalogDetailsActions } from '$lib/catalog/contracts';
  import { libraryEntryMatches } from '$lib/library';
  import type {
    AniListRelationNode, AniListSearchResult, SubsPleaseIndexResponse,
    SubsPleaseIndexShow, SubsPleaseScheduleShow
  } from '$lib/types';

  let {
    loadSearch, loadIndex, loadShow, onPlay, onPlayTrailer, libraryEntries,
    onToggleLibrary, onSetDiscoveryVerdict, onToggleWatched, onShowLoaded,
    preferredQuality, openSlug = '', onOpenConsumed = () => undefined
  }: CatalogDetailsActions & {
    loadSearch: (query: string) => Promise<CatalogSearchResponse>;
    loadIndex: () => Promise<SubsPleaseIndexResponse>;
  } = $props();

  const search = createCatalogSearch((query) => loadSearch(query), () => loadIndex());
  let query = $state('');
  let navigationError = $state('');
  let selectedShow = $state<SubsPleaseScheduleShow | null>(null);
  let detailHistory = $state<SubsPleaseScheduleShow[]>([]);
  let navigationGeneration = 0;
  let disposed = false;
  const selectedEntry = $derived(selectedShow ? libraryEntries.find((entry) =>
    libraryEntryMatches(entry, selectedShow?.anilist_id, selectedShow?.page)) : undefined);

  onDestroy(() => {
    disposed = true;
    navigationGeneration += 1;
    search.dispose();
  });

  $effect(() => {
    const slug = openSlug;
    if (!slug) return;
    let cancelled = false;
    void loadIndex().then((index) => {
      if (cancelled) return;
      const provider = index.shows.find((show) => show.page === slug);
      if (!provider) throw new Error('This show is no longer in the SubsPlease archive.');
      openProvider(provider);
    }).catch((reason) => {
      if (!cancelled) navigationError = errorMessage(reason);
    }).finally(() => {
      if (!cancelled) onOpenConsumed();
    });
    return () => { cancelled = true; };
  });

  function scheduleShow(provider: SubsPleaseIndexShow, anime?: AniListSearchResult | AniListRelationNode): SubsPleaseScheduleShow {
    return {
      title: anime ? preferredTitle(anime) : provider.title,
      page: provider.page,
      image_url: providerImageUrl(anime?.coverImage?.extraLarge ?? anime?.coverImage?.large ?? ''),
      time: '',
      anilist_id: anime?.id
    };
  }

  function openProvider(provider: SubsPleaseIndexShow, anime?: AniListSearchResult): void {
    navigationGeneration += 1;
    navigationError = '';
    detailHistory = [];
    selectedShow = scheduleShow(provider, anime);
  }

  function openResult(anime: AniListSearchResult, match?: ProviderMatch): void {
    if (!match) return;
    const confirmed = match.confidence >= CONFIRMED_MATCH_CONFIDENCE;
    if (confirmed) saveProviderMapping(anime.id, match.provider.page);
    openProvider(match.provider, confirmed ? anime : undefined);
  }

  async function openRelatedShow(media: AniListRelationNode): Promise<void> {
    const generation = ++navigationGeneration;
    const index = search.providerIndex ?? await loadIndex();
    if (disposed || generation !== navigationGeneration) return;
    const match = matchSubsPleaseShow(media, index.shows);
    if (!match || match.confidence < CONFIRMED_MATCH_CONFIDENCE) {
      throw new Error(`${preferredTitle(media)} could not be confidently matched to SubsPlease.`);
    }
    saveProviderMapping(media.id, match.provider.page);
    if (selectedShow) detailHistory = [...detailHistory, selectedShow];
    selectedShow = scheduleShow(match.provider, media);
  }

  function closeDetails(): void {
    navigationGeneration += 1;
    const previous = detailHistory.at(-1);
    detailHistory = previous ? detailHistory.slice(0, -1) : [];
    selectedShow = previous ?? null;
  }

  function runSearch(): void {
    navigationError = '';
    void search.search(query);
  }
</script>

{#if selectedShow}
  <ShowDetailsPage
    show={selectedShow}
    {loadShow} {onPlay} {onPlayTrailer}
    onBack={closeDetails}
    discoveryVerdict={selectedEntry?.discoveryVerdict}
    {onToggleLibrary} {onSetDiscoveryVerdict} {onToggleWatched} {onShowLoaded}
    onOpenRelation={openRelatedShow}
    {preferredQuality}
    libraryEntry={selectedEntry?.following ? selectedEntry : undefined}
  />
{:else}
  <main class="h-full min-h-0 w-full overflow-y-auto bg-(--bg) text-(--text)">
    <ContextToolbar class="flex h-auto min-h-16 flex-wrap justify-between gap-3 py-3">
      <h1 class="text-sm font-semibold">Series search</h1>
      <form class="flex w-full gap-2 sm:max-w-lg" onsubmit={(event) => {
        event.preventDefault();
        runSearch();
      }}>
        <InputGroup class="min-w-0 flex-1">
          <InputGroupAddon><Search class="size-4" /></InputGroupAddon>
          <InputGroupInput bind:value={query} placeholder="Search anime or archive titles" aria-label="Search anime" minlength={2} maxlength={160} />
          {#if query}
            <InputGroupAddon align="inline-end">
              <button type="button" aria-label="Clear search" class="grid size-6 place-items-center rounded-full focus-visible:outline-2" onclick={() => {
                query = '';
                navigationError = '';
                search.clear();
              }}><X class="size-3.5" /></button>
            </InputGroupAddon>
          {/if}
        </InputGroup>
        <Button type="submit" disabled={query.trim().length < 2}>Search</Button>
      </form>
    </ContextToolbar>

    <div class="px-5 pb-24 pt-8 sm:px-8 lg:px-10">
      {#if navigationError}
        <CatalogNotice kind="error" title="Show unavailable" description={navigationError} class="mb-6" />
      {/if}
      {#if search.providerIndex?.cacheWarning}
        <CatalogNotice kind="warning" title="Saved archive" description={search.providerIndex.cacheWarning} class="mb-6" />
      {/if}
      {#if search.cacheWarning}
        <CatalogNotice kind="warning" title="Catalog fallback" description={search.cacheWarning} class="mb-6" />
      {/if}
      {#if search.searchError}
        <CatalogNotice kind="warning" title="Catalog search unavailable" description={search.searchError}
          actionLabel="Retry search" onAction={() => void search.search(search.query)} class="mb-6" />
      {/if}
      {#if search.providerError}
        <CatalogNotice kind="warning" title="SubsPlease could not be checked" description={search.providerError}
          actionLabel="Retry search" onAction={() => void search.search(search.query)} class="mb-6" />
      {/if}

      {#if search.provenance}
        <p class="mb-6 text-xs text-(--text)/45" role="status">
          {search.results.length} {search.results.length === 1 ? 'result' : 'results'} · {catalogSourceLabel(search.provenance)}{search.providerLoading ? ' · Checking SubsPlease…' : ''}
        </p>
      {/if}
      {#if search.animeLoading}
        <CatalogLoading label="Searching catalogs" />
      {:else if search.verifiedResults.length}
        <section class="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6" aria-label={`Search results for ${search.query}`}>
          {#each search.verifiedResults as result (result.anime.id)}
            <SearchResultCard anime={result.anime} match={result.match}
              verified={Boolean(search.providerIndex)} checking={search.providerLoading}
              onOpen={() => openResult(result.anime, result.match)} />
          {/each}
        </section>
      {:else if search.query && search.providerLoading && !search.providerIndex}
        <CatalogLoading label="Searching the SubsPlease archive" />
      {:else if search.query && search.archiveResults.length}
        <section aria-label="SubsPlease archive search results">
          <h2 class="text-base font-medium">SubsPlease archive</h2>
          <p class="mt-2 text-sm text-(--text)/45">{search.archiveResults.length} archive titles · Catalog identity is not verified.</p>
          <div class="mt-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {#each search.archiveResults as provider (provider.page)}
              <Button variant="ghost" class="h-auto min-h-12 justify-start whitespace-normal rounded-xl px-4 py-3 text-left" onclick={() => openProvider(provider)}>
                {provider.title}
              </Button>
            {/each}
          </div>
        </section>
      {:else if search.query}
        <CatalogNotice centered title={search.searchError || search.providerError ? 'The search is incomplete' : 'No titles found'}
          description={search.searchError || search.providerError
            ? 'A catalog service is unavailable. Retry later or browse your library.'
            : 'Try another title, spelling, or romanized name.'} />
      {:else}
        <CatalogNotice centered title="Find an anime series" description="Search across seasons using available catalogs and saved results. SubsPlease archive search remains available during catalog outages." />
      {/if}
    </div>
  </main>
{/if}
