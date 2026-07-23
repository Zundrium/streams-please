<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    ChevronLeft,
    ChevronRight,
    Film,
    Search,
    X
  } from '@lucide/svelte';
  import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert';
  import { Button } from '$lib/components/ui/button';
  import {
    InputGroup,
    InputGroupAddon,
    InputGroupInput
  } from '$lib/components/ui/input-group';
  import { Spinner } from '$lib/components/ui/spinner';
  import AnimePosterCard from '$lib/components/AnimePosterCard.svelte';
  import ContextToolbar from '$lib/components/ContextToolbar.svelte';
  import ShowDetailsPage from '$lib/components/ShowDetailsPage.svelte';
  import {
    availabilitySourceSignature,
    currentSeason,
    loadCachedAvailability,
    loadProviderMappings,
    matchSubsPleaseSeason,
    matchSubsPleaseShow,
    normalizeCatalogTitle,
    saveCachedAvailability,
    saveProviderMapping,
    saveProviderMappings,
    shiftSeason
  } from '$lib/catalog';
  import type { CachedAvailabilityMatch } from '$lib/catalog';
  import { libraryEntryMatches } from '$lib/library';
  import {
    DAY_ORDER,
    type AnimeSeason,
    type AniListRelationNode,
    type AniListSeasonResponse,
    type AniListSeasonShow,
    type DayName,
    type DiscoveryVerdict,
    type EpisodePlaybackRequest,
    type LibraryEntry,
    type PlaybackQuality,
    type SubsPleaseIndexResponse,
    type SubsPleaseIndexShow,
    type SubsPleaseScheduleResponse,
    type SubsPleaseScheduleShow,
    type SubsPleaseShowResponse,
    type TrailerPlaybackRequest
  } from '$lib/types';

  interface AvailableShow {
    anime: AniListSeasonShow;
    provider: SubsPleaseIndexShow;
    confidence: number;
    schedule?: SubsPleaseScheduleShow;
    day?: DayName;
  }

  interface ResolvedSeasonCache {
    sourceSignature: string;
    matches: CachedAvailabilityMatch[];
  }

  let {
    loadSeason,
    loadIndex,
    loadSchedule,
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
    loadSeason: (season: AnimeSeason, year: number) => Promise<AniListSeasonResponse>;
    loadIndex: () => Promise<SubsPleaseIndexResponse>;
    loadSchedule: (timezone: string) => Promise<SubsPleaseScheduleResponse>;
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

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Amsterdam';
  const initialSeason = currentSeason();
  const AVAILABILITY_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const resolvedSeasonCache = new Map<string, ResolvedSeasonCache>();

  let selectedSeason = $state<AnimeSeason>(initialSeason.season);
  let selectedYear = $state(initialSeason.year);
  let catalog = $state<AniListSeasonResponse | null>(null);
  let providerIndex = $state<SubsPleaseIndexResponse | null>(null);
  let schedule = $state<SubsPleaseScheduleResponse | null>(null);
  let availableShows = $state<AvailableShow[]>([]);
  let loading = $state(true);
  let matching = $state(false);
  let archiveLoading = $state(true);
  let catalogError = $state('');
  let providerError = $state('');
  let query = $state('');
  let selectedShow = $state<SubsPleaseScheduleShow | null>(null);
  let selectedDay = $state<DayName | undefined>(undefined);
  let detailHistory = $state<Array<{ show: SubsPleaseScheduleShow; day?: DayName }>>([]);
  let selectedIsCurrentSeason = $derived(
    selectedSeason === initialSeason.season && selectedYear === initialSeason.year
  );
  let providerLoading = $derived(!providerIndex && archiveLoading);
  let seasonRequestId = 0;
  let matchRequestId = 0;

  let filteredShows = $derived.by(() => {
    const term = normalizeCatalogTitle(query);
    if (!term) return availableShows;
    return availableShows.filter(({ anime, provider }) =>
      [
        anime.title.userPreferred,
        anime.title.english,
        anime.title.romaji,
        anime.title.native,
        ...(anime.synonyms ?? []),
        provider.title
      ].some((title) => title && normalizeCatalogTitle(title).includes(term))
    );
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

  onMount(() => {
    void Promise.all([refreshProviderData(), refreshSeason()]);
  });

  $effect(() => {
    const slug = openSlug;
    if (!slug || !availableShows.length) return;
    const match = availableShows.find(({ provider }) => provider.page === slug);
    if (!match) return;
    openAvailableShow(match);
    onOpenConsumed();
  });

  function preferredTitle(show: AniListSeasonShow): string {
    return (
      show.title.english ??
      show.title.userPreferred ??
      show.title.romaji ??
      show.title.native ??
      `AniList #${show.id}`
    );
  }

  function providerPool(): SubsPleaseIndexShow[] {
    return providerIndex?.shows ?? [];
  }

  function scheduledProvider(slug: string): {
    show: SubsPleaseScheduleShow;
    day: DayName;
  } | undefined {
    for (const day of DAY_ORDER) {
      const show = schedule?.schedule[day]?.find((candidate) => candidate.page === slug);
      if (show) return { show, day };
    }
    return undefined;
  }

  function hydrateAvailableShows(
    catalogData: AniListSeasonResponse,
    providers: SubsPleaseIndexShow[],
    matches: CachedAvailabilityMatch[]
  ): AvailableShow[] {
    const animeById = new Map(catalogData.shows.map((show) => [show.id, show]));
    const providerByPage = new Map(providers.map((show) => [show.page, show]));
    return matches
      .flatMap((match): AvailableShow[] => {
        const anime = animeById.get(match.anilistId);
        const provider = providerByPage.get(match.providerPage);
        if (!anime || !provider) return [];
        const scheduled = scheduledProvider(provider.page);
        return [{
          anime,
          provider,
          confidence: match.confidence,
          schedule: scheduled?.show,
          day: scheduled?.day
        }];
      })
      .sort((left, right) => {
        const leftAir = left.anime.nextAiringEpisode?.airingAt ?? Number.MAX_SAFE_INTEGER;
        const rightAir = right.anime.nextAiringEpisode?.airingAt ?? Number.MAX_SAFE_INTEGER;
        if (leftAir !== rightAir) return leftAir - rightAir;
        return preferredTitle(left.anime).localeCompare(preferredTitle(right.anime));
      });
  }

  function refreshScheduleAnnotations(): void {
    availableShows = availableShows.map((item) => {
      const scheduled = scheduledProvider(item.provider.page);
      return {
        ...item,
        schedule: scheduled?.show,
        day: scheduled?.day
      };
    });
  }

  async function yieldLoadingFrame(): Promise<void> {
    await tick();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }

  async function rebuildAvailableShows(): Promise<void> {
    const catalogData = catalog;
    const providerData = providerIndex;
    if (!catalogData || !providerData) {
      availableShows = [];
      return;
    }

    const cacheKey = `${catalogData.season}:${catalogData.year}`;
    const sourceSignature = availabilitySourceSignature(catalogData, providerData);
    const memoryEntry = resolvedSeasonCache.get(cacheKey);
    const cachedMatches =
      memoryEntry?.sourceSignature === sourceSignature
        ? memoryEntry.matches
        : loadCachedAvailability(
            catalogData.season,
            catalogData.year,
            sourceSignature,
            AVAILABILITY_CACHE_MAX_AGE_MS
          );
    if (cachedMatches) {
      resolvedSeasonCache.set(cacheKey, { sourceSignature, matches: cachedMatches });
      availableShows = hydrateAvailableShows(catalogData, providerData.shows, cachedMatches);
      matching = false;
      return;
    }

    const requestId = ++matchRequestId;
    matching = true;
    availableShows = [];
    await yieldLoadingFrame();
    if (
      requestId !== matchRequestId ||
      catalog !== catalogData ||
      providerIndex !== providerData
    ) {
      return;
    }

    const providerMatches = matchSubsPleaseSeason(
      catalogData.shows,
      providerPool(),
      loadProviderMappings()
    );
    const matches = catalogData.shows.flatMap((anime): CachedAvailabilityMatch[] => {
      const match = providerMatches.get(anime.id);
      return match
        ? [{
            anilistId: anime.id,
            providerPage: match.provider.page,
            confidence: match.confidence
          }]
        : [];
    });
    saveProviderMappings(
      matches
        .filter((match) => match.confidence >= 0.82)
        .map((match) => [match.anilistId, match.providerPage])
    );
    saveCachedAvailability(
      catalogData.season,
      catalogData.year,
      sourceSignature,
      matches
    );
    resolvedSeasonCache.set(cacheKey, { sourceSignature, matches });
    if (requestId !== matchRequestId || catalog !== catalogData) return;
    availableShows = hydrateAvailableShows(catalogData, providerData.shows, matches);
    matching = false;
  }

  async function refreshProviderData(): Promise<void> {
    archiveLoading = true;
    providerError = '';
    const indexRequest = loadIndex()
      .then(async (result) => {
        providerIndex = result;
        await rebuildAvailableShows();
      })
      .catch((reason) => {
        providerError =
          reason instanceof Error
            ? reason.message
            : String(reason);
      })
      .finally(() => {
        archiveLoading = false;
      });
    const scheduleRequest = loadSchedule(timezone)
      .then((result) => {
        schedule = result;
        refreshScheduleAnnotations();
      });
    await Promise.allSettled([indexRequest, scheduleRequest]);
  }

  async function refreshSeason(): Promise<void> {
    const requestId = ++seasonRequestId;
    matchRequestId += 1;
    const requestedSeason = selectedSeason;
    const requestedYear = selectedYear;
    loading = true;
    matching = false;
    availableShows = [];
    catalogError = '';
    selectedShow = null;
    detailHistory = [];
    await yieldLoadingFrame();
    try {
      const nextCatalog = await loadSeason(requestedSeason, requestedYear);
      if (
        requestId !== seasonRequestId ||
        selectedSeason !== requestedSeason ||
        selectedYear !== requestedYear
      ) return;
      catalog = nextCatalog;
      loading = false;
      await rebuildAvailableShows();
    } catch (reason) {
      if (
        requestId !== seasonRequestId ||
        selectedSeason !== requestedSeason ||
        selectedYear !== requestedYear
      ) return;
      catalog = null;
      catalogError = reason instanceof Error ? reason.message : String(reason);
      loading = false;
    }
  }

  function moveSeason(amount: number): void {
    const next = shiftSeason(selectedSeason, selectedYear, amount);
    selectedSeason = next.season;
    selectedYear = next.year;
    void refreshSeason();
  }

  function posterUrl(show: AvailableShow): string {
    const path =
      show.anime.coverImage?.extraLarge ??
      show.anime.coverImage?.large ??
      show.schedule?.image_url ??
      '';
    if (!path || path.startsWith('http')) return path;
    return `https://subsplease.org${path.startsWith('/') ? '' : '/'}${path}`;
  }

  function subsPleaseScheduleLabel(show: AvailableShow): string {
    if (!show.schedule?.time) return 'Archive';
    return `${show.day?.slice(0, 3) ?? ''} ${show.schedule.time}`.trim();
  }

  function seasonLabel(season: AnimeSeason): string {
    return `${season[0]}${season.slice(1).toLowerCase()}`;
  }

  function openAvailableShow(item: AvailableShow): void {
    saveProviderMapping(item.anime.id, item.provider.page);
    detailHistory = [];
    selectedDay = item.day;
    selectedShow = {
      title: preferredTitle(item.anime),
      page: item.provider.page,
      image_url: posterUrl(item),
      time: item.schedule?.time ?? '',
      anilist_id: item.anime.id
    };
  }

  function relatedTitle(media: AniListRelationNode): string {
    return (
      media.title.english ??
      media.title.userPreferred ??
      media.title.romaji ??
      media.title.native ??
      `AniList #${media.id}`
    );
  }

  async function openRelatedShow(media: AniListRelationNode): Promise<void> {
    const providers = providerIndex ?? await loadIndex();
    const match = matchSubsPleaseShow(media, providers.shows, loadProviderMappings());
    if (!match) {
      throw new Error(`${relatedTitle(media)} is not available in the SubsPlease archive.`);
    }

    saveProviderMapping(media.id, match.provider.page);
    const scheduled = scheduledProvider(match.provider.page);
    const nextShow: SubsPleaseScheduleShow = {
      title: relatedTitle(media),
      page: match.provider.page,
      image_url: media.coverImage?.extraLarge ?? media.coverImage?.large ?? '',
      time: scheduled?.show.time ?? '',
      anilist_id: media.id,
      subsplease_id: scheduled?.show.subsplease_id
    };
    if (selectedShow) {
      detailHistory = [...detailHistory, { show: selectedShow, day: selectedDay }];
    }
    selectedDay = scheduled?.day;
    selectedShow = nextShow;
  }

  function closeDetails(): void {
    const previous = detailHistory.at(-1);
    if (previous) {
      detailHistory = detailHistory.slice(0, -1);
      selectedShow = previous.show;
      selectedDay = previous.day;
      return;
    }
    selectedShow = null;
    selectedDay = undefined;
  }
</script>

{#if selectedShow}
  <ShowDetailsPage
    show={selectedShow}
    day={selectedDay}
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
      <p class="col-start-1 row-start-1 min-w-0 truncate text-xs text-(--text)/38 justify-self-start">
        {#if loading || providerLoading || matching}
          Matching AniList with SubsPlease…
        {:else}
          {filteredShows.length} of {catalog?.shows.length ?? 0} available
        {/if}
      </p>

      <nav class="col-start-2 row-start-1 flex shrink-0 items-center gap-2 justify-self-center" aria-label="SubsPlease season">
        <Button variant="ghost" size="icon" aria-label="Previous season" onclick={() => moveSeason(-1)}>
          <ChevronLeft class="size-4" />
        </Button>
        <h1
          aria-current={selectedIsCurrentSeason ? 'date' : undefined}
          class={`min-w-28 rounded-full px-2 py-2.5 text-center text-sm font-semibold transition-colors sm:min-w-40 sm:px-5 ${
            selectedIsCurrentSeason
              ? 'bg-(--text) text-(--bg)'
              : 'text-(--text)/75'
          }`}
        >
          {seasonLabel(selectedSeason)} {selectedYear}
        </h1>
        <Button variant="ghost" size="icon" aria-label="Next season" onclick={() => moveSeason(1)}>
          <ChevronRight class="size-4" />
        </Button>
      </nav>

      <InputGroup class="col-start-3 row-start-1 min-w-0 w-full max-w-md justify-self-end">
        <InputGroupAddon><Search class="size-4" /></InputGroupAddon>
        <InputGroupInput bind:value={query} placeholder="Search this season" aria-label="Search this season" />
        {#if query}
          <InputGroupAddon align="inline-end">
            <button type="button" aria-label="Clear search" class="grid size-6 place-items-center" onclick={() => (query = '')}>
              <X class="size-3.5" />
            </button>
          </InputGroupAddon>
        {/if}
      </InputGroup>
    </ContextToolbar>

    <div class="px-5 pb-24 pt-8 sm:px-8 lg:px-10">
    {#if loading || providerLoading || matching}
      <div class="grid min-h-[430px] place-items-center">
        <div class="flex flex-col items-center gap-3 text-sm text-(--text)/45">
          <Spinner class="size-7" />
          <b class="text-(--text)/70">
            {loading
              ? 'Loading AniList season'
              : providerLoading
                ? 'Loading SubsPlease availability'
                : 'Matching this season'}
          </b>
        </div>
      </div>
    {:else if catalogError}
      <Alert variant="destructive" class="mt-8">
        <AlertTitle>Season unavailable</AlertTitle>
        <AlertDescription>{catalogError}</AlertDescription>
        <Button variant="ghost" size="sm" class="mt-3" onclick={() => void refreshSeason()}>Try again</Button>
      </Alert>
    {:else}
      {#if providerError}
        <Alert class="mt-6">
          <AlertTitle>Historical SubsPlease index unavailable</AlertTitle>
          <AlertDescription>
            {providerError} Current weekly matches may still be shown.
          </AlertDescription>
        </Alert>
      {/if}

      {#if filteredShows.length}
        <section class="mt-7 grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
          {#each filteredShows as item (item.anime.id)}
            {@const entry = libraryEntries.find((candidate) => libraryEntryMatches(candidate, item.anime.id, item.provider.page))}
            <AnimePosterCard
              title={preferredTitle(item.anime)}
              imageUrl={posterUrl(item)}
              verdict={entry?.discoveryVerdict}
              bottomLeft={item.anime.episodes ? `${item.anime.episodes} eps` : 'Episodes TBA'}
              bottomRight={`SP ${subsPleaseScheduleLabel(item)}`}
              onOpen={() => openAvailableShow(item)}
            />
          {/each}
        </section>
      {:else}
        <div class="grid min-h-[390px] place-items-center text-center">
          <div class="max-w-sm">
            <span class="mx-auto grid size-14 place-items-center rounded-full bg-(--surface-strong)">
              <Film class="size-6 text-(--text)/28" />
            </span>
            <h2 class="mt-4 text-lg font-medium">No SubsPlease matches found</h2>
            <p class="mt-2 text-sm leading-6 text-(--text)/42">
              {query
                ? 'No available title matches this search.'
                : 'AniList has titles for this season, but none could be matched to the SubsPlease archive.'}
            </p>
          </div>
        </div>
      {/if}
    {/if}
    </div>
  </main>
{/if}
