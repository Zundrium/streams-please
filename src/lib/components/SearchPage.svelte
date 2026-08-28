<script lang="ts">
  import {
    CheckCircle2,
    CircleHelp,
    Film,
    Search,
    X
  } from '@lucide/svelte';
  import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import {
    InputGroup,
    InputGroupAddon,
    InputGroupInput
  } from '$lib/components/ui/input-group';
  import { Spinner } from '$lib/components/ui/spinner';
  import ContextToolbar from '$lib/components/ContextToolbar.svelte';
  import RevealImage from '$lib/components/RevealImage.svelte';
  import ShowDetailsPage from '$lib/components/ShowDetailsPage.svelte';
  import {
    loadProviderMappings,
    matchSubsPleaseSeason,
    matchSubsPleaseShow,
    saveProviderMapping,
    type ProviderMatch
  } from '$lib/catalog';
  import { libraryEntryMatches } from '$lib/library';
  import type {
    AniListRelationNode,
    AniListSearchResult,
    DayName,
    DiscoveryVerdict,
    EpisodePlaybackRequest,
    LibraryEntry,
    PlaybackQuality,
    SubsPleaseIndexResponse,
    SubsPleaseIndexShow,
    SubsPleaseScheduleShow,
    SubsPleaseShowResponse,
    TrailerPlaybackRequest
  } from '$lib/types';

  interface VerifiedResult {
    anime: AniListSearchResult;
    match?: ProviderMatch;
  }

  type SearchResponses = [
    PromiseSettledResult<AniListSearchResult[]>,
    PromiseSettledResult<SubsPleaseIndexResponse>
  ];

  let {
    loadSearch,
    loadIndex,
    loadShow,
    onPlay,
    onPlayTrailer,
    libraryEntries,
    onToggleLibrary,
    onSetDiscoveryVerdict,
    onToggleWatched,
    onShowLoaded,
    preferredQuality,
    openSlug = '',
    onOpenConsumed = () => undefined
  }: {
    loadSearch: (query: string) => Promise<AniListSearchResult[]>;
    loadIndex: () => Promise<SubsPleaseIndexResponse>;
    loadShow: (
      slug: string,
      timezone: string,
      anilistId?: number
    ) => Promise<SubsPleaseShowResponse>;
    onPlay: (request: EpisodePlaybackRequest) => Promise<void>;
    onPlayTrailer: (request: TrailerPlaybackRequest) => void | Promise<void>;
    libraryEntries: LibraryEntry[];
    onToggleLibrary: (
      details: SubsPleaseShowResponse,
      show: SubsPleaseScheduleShow,
      day?: DayName
    ) => void;
    onSetDiscoveryVerdict: (
      details: SubsPleaseShowResponse,
      show: SubsPleaseScheduleShow,
      day: DayName | undefined,
      verdict?: DiscoveryVerdict
    ) => void;
    onToggleWatched: (slug: string, episode: string) => void;
    onShowLoaded: (
      details: SubsPleaseShowResponse,
      show: SubsPleaseScheduleShow,
      day?: DayName
    ) => void;
    preferredQuality: PlaybackQuality;
    openSlug?: string;
    onOpenConsumed?: () => void;
  } = $props();

  const CONFIRMED_MATCH_CONFIDENCE = 0.95;

  let query = $state('');
  let searchedQuery = $state('');
  let results = $state<AniListSearchResult[]>([]);
  let providerIndex = $state<SubsPleaseIndexResponse | null>(null);
  let loading = $state(false);
  let searchError = $state('');
  let providerError = $state('');
  let selectedShow = $state<SubsPleaseScheduleShow | null>(null);
  let detailHistory = $state<SubsPleaseScheduleShow[]>([]);
  let searchRequestId = 0;

  let verifiedResults = $derived.by((): VerifiedResult[] => {
    const matches = providerIndex
      ? matchSubsPleaseSeason(results, providerIndex.shows, loadProviderMappings())
      : new Map<number, ProviderMatch>();
    return results.map((anime) => ({ anime, match: matches.get(anime.id) }));
  });
  let selectedLibraryEntry = $derived(
    selectedShow
      ? libraryEntries.find(
          (entry) =>
            entry.following &&
            libraryEntryMatches(entry, selectedShow?.anilist_id, selectedShow?.page)
        )
      : undefined
  );
  let selectedDiscoveryVerdict = $derived(
    selectedShow
      ? libraryEntries.find((entry) =>
          libraryEntryMatches(entry, selectedShow?.anilist_id, selectedShow?.page)
        )?.discoveryVerdict
      : undefined
  );

  $effect(() => {
    const slug = openSlug;
    if (slug) void openRequestedShow(slug);
  });

  function validSearch(term: string): boolean {
    if (term.length >= 2) return true;
    searchError = 'Enter at least two characters to search AniList.';
    results = [];
    return false;
  }

  function beginSearch(term: string): number {
    loading = true;
    searchError = '';
    providerError = '';
    searchedQuery = term;
    return ++searchRequestId;
  }

  async function runSearch(): Promise<void> {
    const term = query.trim();
    if (!validSearch(term)) return;
    const requestId = beginSearch(term);
    const responses = await Promise.allSettled([loadSearch(term), loadIndex()]);
    if (requestId !== searchRequestId) return;
    finishSearch(responses);
  }

  function finishSearch([animeResponse, providerResponse]: SearchResponses): void {
    applyAnimeResponse(animeResponse);
    applyProviderResponse(providerResponse);
    loading = false;
  }

  function applyAnimeResponse(response: SearchResponses[0]): void {
    results = response.status === 'fulfilled' ? response.value : [];
    searchError = response.status === 'rejected' ? errorMessage(response.reason) : '';
  }

  function applyProviderResponse(response: SearchResponses[1]): void {
    providerIndex = response.status === 'fulfilled' ? response.value : null;
    providerError = response.status === 'rejected' ? errorMessage(response.reason) : '';
  }

  function clearSearch(): void {
    searchRequestId += 1;
    query = '';
    searchedQuery = '';
    results = [];
    searchError = '';
    providerError = '';
    loading = false;
  }

  function errorMessage(reason: unknown): string {
    return reason instanceof Error ? reason.message : String(reason);
  }

  function preferredTitle(anime: AniListSearchResult): string {
    return anime.title.english ??
      anime.title.userPreferred ??
      anime.title.romaji ??
      anime.title.native ??
      `AniList #${anime.id}`;
  }

  function posterUrl(anime: AniListSearchResult): string {
    return anime.coverImage?.extraLarge ?? anime.coverImage?.large ?? '';
  }

  function metadataLabel(value: string): string {
    if (['TV', 'ONA', 'OVA'].includes(value)) return value;
    return value
      .toLowerCase()
      .replaceAll('_', ' ')
      .replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
  }

  function resultMetadata(anime: AniListSearchResult): string {
    return [
      anime.format ? metadataLabel(anime.format) : '',
      anime.seasonYear ? String(anime.seasonYear) : '',
      anime.episodes ? `${anime.episodes} episodes` : ''
    ].filter(Boolean).join(' · ');
  }

  function openResult(result: VerifiedResult): void {
    if (!result.match) return;
    detailHistory = [];
    if (!confirmedMatch(result)) {
      selectedShow = scheduleShow(result.match.provider);
      return;
    }
    saveProviderMapping(result.anime.id, result.match.provider.page);
    selectedShow = scheduleShow(result.match.provider, result.anime);
  }

  function scheduleShow(
    provider: SubsPleaseIndexShow,
    anime?: AniListSearchResult | AniListRelationNode
  ): SubsPleaseScheduleShow {
    return {
      title: anime ? preferredMediaTitle(anime) : provider.title,
      page: provider.page,
      image_url: anime?.coverImage?.extraLarge ?? anime?.coverImage?.large ?? '',
      time: '',
      anilist_id: anime?.id
    };
  }

  function preferredMediaTitle(anime: AniListSearchResult | AniListRelationNode): string {
    return anime.title.english ??
      anime.title.userPreferred ??
      anime.title.romaji ??
      anime.title.native ??
      `AniList #${anime.id}`;
  }

  async function openRequestedShow(slug: string): Promise<void> {
    try {
      const index = await loadIndex();
      providerIndex = index;
      const provider = index.shows.find((show) => show.page === slug);
      if (!provider) throw new Error('This show is no longer in the SubsPlease archive.');
      detailHistory = [];
      selectedShow = scheduleShow(provider);
    } catch (reason) {
      searchError = errorMessage(reason);
    } finally {
      onOpenConsumed();
    }
  }

  async function openRelatedShow(media: AniListRelationNode): Promise<void> {
    const index = providerIndex ?? await loadIndex();
    const match = matchSubsPleaseShow(media, index.shows, loadProviderMappings());
    if (!match) throw new Error(`${preferredMediaTitle(media)} is not available on SubsPlease.`);
    providerIndex = index;
    saveProviderMapping(media.id, match.provider.page);
    if (selectedShow) detailHistory = [...detailHistory, selectedShow];
    selectedShow = scheduleShow(match.provider, media);
  }

  function closeDetails(): void {
    const previous = detailHistory.at(-1);
    detailHistory = previous ? detailHistory.slice(0, -1) : [];
    selectedShow = previous ?? null;
  }

  function confirmedMatch(result: VerifiedResult): boolean {
    return (result.match?.confidence ?? 0) >= CONFIRMED_MATCH_CONFIDENCE;
  }

  function availabilityLabel(result: VerifiedResult): string {
    if (!providerIndex) return 'Could not verify';
    if (!result.match) return 'Not found on SubsPlease';
    return confirmedMatch(result) ? 'Available on SubsPlease' : 'Possible SubsPlease match';
  }
</script>

{#if selectedShow}
  <ShowDetailsPage
    show={selectedShow}
    {loadShow}
    {onPlay}
    {onPlayTrailer}
    onBack={closeDetails}
    discoveryVerdict={selectedDiscoveryVerdict}
    {onToggleLibrary}
    {onSetDiscoveryVerdict}
    {onToggleWatched}
    {onShowLoaded}
    onOpenRelation={openRelatedShow}
    {preferredQuality}
    libraryEntry={selectedLibraryEntry}
  />
{:else}
  <main class="h-full min-h-0 w-full overflow-y-auto bg-(--bg) text-(--text)">
    <ContextToolbar class="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-4 sm:gap-8">
      <p class="min-w-0 truncate text-xs text-(--text)/38">
        {#if loading}
          Checking AniList and SubsPlease…
        {:else if searchedQuery}
          {results.length} AniList {results.length === 1 ? 'result' : 'results'}
        {:else}
          Global series lookup
        {/if}
      </p>

      <h1 class="text-sm font-semibold">Series search</h1>

      <form class="flex min-w-0 w-full max-w-lg justify-self-end gap-2" onsubmit={(event) => {
        event.preventDefault();
        void runSearch();
      }}>
        <InputGroup class="min-w-0 flex-1">
          <InputGroupAddon><Search class="size-4" /></InputGroupAddon>
          <InputGroupInput
            bind:value={query}
            placeholder="Search AniList"
            aria-label="Search AniList"
            minlength={2}
            maxlength={160}
            autofocus
          />
          {#if query}
            <InputGroupAddon align="inline-end">
              <button type="button" aria-label="Clear search" class="grid size-6 place-items-center" onclick={clearSearch}>
                <X class="size-3.5" />
              </button>
            </InputGroupAddon>
          {/if}
        </InputGroup>
        <Button type="submit" disabled={loading || query.trim().length < 2}>Search</Button>
      </form>
    </ContextToolbar>

    <div class="px-5 pb-24 pt-8 sm:px-8 lg:px-10">
      {#if loading}
        <section class="grid min-h-[430px] place-items-center" aria-busy="true" role="status">
          <div class="flex flex-col items-center gap-3 text-sm text-(--text)/45">
            <Spinner class="size-7" />
            <b class="text-(--text)/70">Verifying SubsPlease availability</b>
          </div>
        </section>
      {:else if searchError}
        <Alert variant="destructive" class="mx-auto mt-8 max-w-xl">
          <AlertTitle>Search unavailable</AlertTitle>
          <AlertDescription>{searchError}</AlertDescription>
          {#if searchedQuery}
            <Button variant="ghost" size="sm" class="mt-3" onclick={() => void runSearch()}>Try again</Button>
          {/if}
        </Alert>
      {:else if verifiedResults.length}
        {#if providerError}
          <Alert class="mb-8">
            <CircleHelp class="size-4" />
            <AlertTitle>SubsPlease could not be checked</AlertTitle>
            <AlertDescription>{providerError}</AlertDescription>
          </Alert>
        {/if}

        <section class="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6" aria-label={`Search results for ${searchedQuery}`}>
          {#each verifiedResults as result (result.anime.id)}
            <article class="group min-w-0">
              <div class="relative aspect-[2/3] overflow-hidden rounded-xl bg-(--text)/5 ring-1 ring-white/6">
                {#if posterUrl(result.anime)}
                  <RevealImage
                    src={posterUrl(result.anime)}
                    alt=""
                    loading="lazy"
                    class="size-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.03]"
                  />
                {:else}
                  <span class="grid size-full place-items-center"><Film class="size-8 text-(--text)/22" /></span>
                {/if}
                <span class="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-black/90 to-transparent"></span>
                <Badge class={`absolute bottom-3 left-3 right-3 justify-center truncate border-0 py-1.5 text-[10px] shadow-lg backdrop-blur-md ${
                  result.match
                    ? confirmedMatch(result)
                      ? 'bg-emerald-500/88 text-white'
                      : 'bg-amber-500/88 text-white'
                    : providerIndex
                      ? 'bg-black/65 text-white/72'
                      : 'bg-black/65 text-white/72'
                }`}>
                  {#if confirmedMatch(result)}<CheckCircle2 class="size-3" />{:else}<CircleHelp class="size-3" />{/if}
                  {availabilityLabel(result)}
                </Badge>
              </div>

              <h2 class="mt-3 line-clamp-2 h-10 text-sm font-medium leading-5 lg:h-12 lg:text-base lg:leading-6">
                {preferredTitle(result.anime)}
              </h2>
              <p class="mt-1 truncate text-xs text-(--text)/40">{resultMetadata(result.anime) || 'Anime series'}</p>

              {#if result.match}
                <p class="mt-2 truncate text-xs text-(--text)/48" title={result.match.provider.title}>
                  SubsPlease: {result.match.provider.title}
                </p>
                <Button variant="ghost" size="sm" class="mt-2 w-full" onclick={() => openResult(result)}>
                  {confirmedMatch(result) ? 'Open series' : 'Review match'}
                </Button>
              {:else}
                <p class="mt-2 text-xs leading-5 text-(--text)/38">
                  {providerIndex ? 'No archive title matched this AniList result.' : 'Availability is unknown.'}
                </p>
              {/if}
            </article>
          {/each}
        </section>
      {:else if searchedQuery}
        <section class="grid min-h-[390px] place-items-center text-center">
          <div class="max-w-sm">
            <span class="mx-auto grid size-14 place-items-center rounded-full bg-(--surface-strong)">
              <Search class="size-6 text-(--text)/28" />
            </span>
            <h2 class="mt-4 text-lg font-medium">No AniList results found</h2>
            <p class="mt-2 text-sm leading-6 text-(--text)/42">Try another title, spelling, or romanized name.</p>
          </div>
        </section>
      {:else}
        <section class="grid min-h-[430px] place-items-center text-center">
          <div class="max-w-lg">
            <span class="mx-auto grid size-16 place-items-center rounded-full bg-chart-1/10 text-chart-1">
              <Search class="size-7" />
            </span>
            <h2 class="mt-5 text-2xl font-semibold tracking-[-0.045em]">Find any anime series</h2>
            <p class="mt-2 text-sm leading-6 text-(--text)/45">
              Search AniList by English, Japanese, or romanized title. Every result is checked against the SubsPlease show archive.
            </p>
          </div>
        </section>
      {/if}
    </div>
  </main>
{/if}
