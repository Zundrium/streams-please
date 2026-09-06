<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { Search, X } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    InputGroup,
    InputGroupAddon,
    InputGroupInput
  } from '$lib/components/ui/input-group';
  import AnimePosterCard from '$lib/components/catalog/AnimePosterCard.svelte';
  import CatalogLoading from '$lib/components/catalog/CatalogLoading.svelte';
  import CatalogNotice from '$lib/components/catalog/CatalogNotice.svelte';
  import SeasonNavigator from '$lib/components/catalog/SeasonNavigator.svelte';
  import ContextToolbar from '$lib/components/shared/ContextToolbar.svelte';
  import ShowDetailsPage from '$lib/components/catalog/ShowDetailsPage.svelte';
  import {
    currentSeason,
    loadProviderMappings,
    matchSubsPleaseShow,
    normalizeCatalogTitle,
    preferredTitle,
    providerImageUrl,
    saveProviderMapping
  } from '$lib/catalog';
  import {
    CONFIRMED_PROVIDER_MATCH_CONFIDENCE,
    createSeasonCatalog,
    type SeasonCatalogMatch
  } from '$lib/catalog/season.svelte';
  import { libraryEntryMatches } from '$lib/library';
  import type { CatalogDetailsActions } from '$lib/catalog/contracts';
  import CatalogStatusBadge from '$lib/components/catalog/CatalogStatusBadge.svelte';
  import {
    DAY_ORDER,
    type AnimeSeason,
    type AniListRelationNode,
    type AniListSeasonResponse,
    type DayName,
    type SubsPleaseIndexResponse,
    type SubsPleaseIndexShow,
    type SubsPleaseScheduleResponse,
    type SubsPleaseScheduleShow
  } from '$lib/types';

  type CatalogMode = 'season' | 'archive';

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
  }: CatalogDetailsActions & {
    loadSeason: (season: AnimeSeason, year: number) => Promise<AniListSeasonResponse>;
    loadIndex: () => Promise<SubsPleaseIndexResponse>;
    loadSchedule: (timezone: string) => Promise<SubsPleaseScheduleResponse>;
  } = $props();

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Amsterdam';
  const initialSeason = currentSeason();
  const seasonCatalog = createSeasonCatalog({
    loadSeason: (season, year) => loadSeason(season, year),
    loadIndex: () => loadIndex(),
    loadSchedule: (requestedTimezone) => loadSchedule(requestedTimezone),
    timezone,
    initialSeason
  });

  let mode = $state<CatalogMode>('season');
  let query = $state('');
  let archiveLimit = $state(60);
  let requestedShowError = $state('');
  let selectedShow = $state<SubsPleaseScheduleShow | null>(null);
  let selectedDay = $state<DayName | undefined>(undefined);
  let detailHistory = $state<Array<{ show: SubsPleaseScheduleShow; day?: DayName }>>([]);
  let navigationGeneration = 0;
  let disposed = false;

  let selectedIsCurrentSeason = $derived(
    seasonCatalog.season === initialSeason.season && seasonCatalog.year === initialSeason.year
  );
  let availableShows = $derived.by(() =>
    [...seasonCatalog.seasonMatches].sort((left, right) => {
      const leftAir = left.anime.nextAiringEpisode?.airingAt ?? Number.MAX_SAFE_INTEGER;
      const rightAir = right.anime.nextAiringEpisode?.airingAt ?? Number.MAX_SAFE_INTEGER;
      if (leftAir !== rightAir) return leftAir - rightAir;
      return preferredTitle(left.anime).localeCompare(preferredTitle(right.anime));
    })
  );
  let filteredShows = $derived.by(() => {
    const term = normalizeCatalogTitle(query);
    if (!term) return availableShows;
    return availableShows.filter(({ anime, provider }) =>
      [
        provider.title,
        anime.title.userPreferred,
        anime.title.english,
        anime.title.romaji,
        anime.title.native,
        ...(anime.synonyms ?? [])
      ].some((title) => title && normalizeCatalogTitle(title).includes(term))
    );
  });
  let archiveShows = $derived.by(() =>
    [...(seasonCatalog.providerIndex?.shows ?? [])].sort((left, right) =>
      left.title.localeCompare(right.title)
    )
  );
  let filteredArchiveShows = $derived.by(() => {
    const term = normalizeCatalogTitle(query);
    if (!term) return archiveShows;
    return archiveShows.filter((show) => normalizeCatalogTitle(show.title).includes(term));
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
    void seasonCatalog.load();
    return () => seasonCatalog.dispose();
  });

  onDestroy(() => {
    disposed = true;
    navigationGeneration += 1;
  });

  $effect(() => {
    query;
    archiveLimit = 60;
  });

  $effect(() => {
    const slug = openSlug;
    const index = seasonCatalog.providerIndex;
    if (!slug || !index) return;

    const provider = index.shows.find((show) => show.page === slug);
    mode = 'archive';
    query = '';
    if (provider) {
      openArchiveShow(provider);
    } else {
      requestedShowError = 'This show is no longer in the SubsPlease archive.';
    }
    onOpenConsumed();
  });

  function scheduledProvider(slug: string): {
    show: SubsPleaseScheduleShow;
    day: DayName;
  } | undefined {
    for (const day of DAY_ORDER) {
      const show = seasonCatalog.schedule?.schedule[day]?.find(
        (candidate) => candidate.page === slug
      );
      if (show) return { show, day };
    }
    return undefined;
  }

  function selectMode(nextMode: CatalogMode): void {
    mode = nextMode;
    query = '';
    requestedShowError = '';
  }

  function moveSeason(amount: number): void {
    navigationGeneration += 1;
    selectedShow = null;
    selectedDay = undefined;
    detailHistory = [];
    requestedShowError = '';
    seasonCatalog.moveSeason(amount);
  }

  function posterUrl(show: SeasonCatalogMatch): string {
    const path =
      show.anime.coverImage?.extraLarge ??
      show.anime.coverImage?.large ??
      show.schedule?.image_url ??
      '';
    return providerImageUrl(path);
  }

  function archivePosterUrl(show: SubsPleaseIndexShow): string {
    return providerImageUrl(scheduledProvider(show.page)?.show.image_url ?? '');
  }

  function openAvailableShow(item: SeasonCatalogMatch): void {
    navigationGeneration += 1;
    if (item.confidence >= CONFIRMED_PROVIDER_MATCH_CONFIDENCE) {
      saveProviderMapping(item.anime.id, item.provider.page);
    }
    requestedShowError = '';
    detailHistory = [];
    selectedDay = item.day;
    selectedShow = {
      title: preferredTitle(item.anime),
      page: item.provider.page,
      image_url: posterUrl(item),
      time: item.schedule?.time ?? '',
      anilist_id: item.anime.id,
      subsplease_id: item.schedule?.subsplease_id
    };
  }

  function openArchiveShow(provider: SubsPleaseIndexShow): void {
    navigationGeneration += 1;
    const scheduled = scheduledProvider(provider.page);
    requestedShowError = '';
    detailHistory = [];
    selectedDay = scheduled?.day;
    selectedShow = {
      title: provider.title,
      page: provider.page,
      image_url: providerImageUrl(scheduled?.show.image_url ?? ''),
      time: scheduled?.show.time ?? '',
      subsplease_id: scheduled?.show.subsplease_id
    };
  }

  async function openRelatedShow(media: AniListRelationNode): Promise<void> {
    const generation = ++navigationGeneration;
    const providers = seasonCatalog.providerIndex ?? await seasonCatalog.refreshProvider();
    if (disposed || generation !== navigationGeneration) return;
    if (!providers) {
      throw new Error(seasonCatalog.providerError || 'The SubsPlease archive is unavailable.');
    }

    const match = matchSubsPleaseShow(media, providers.shows, loadProviderMappings());
    if (!match || match.confidence < CONFIRMED_PROVIDER_MATCH_CONFIDENCE) {
      throw new Error(
        `${preferredTitle(media)} could not be confidently matched in the SubsPlease archive.`
      );
    }

    saveProviderMapping(media.id, match.provider.page);
    const scheduled = scheduledProvider(match.provider.page);
    const nextShow: SubsPleaseScheduleShow = {
      title: preferredTitle(media),
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
    navigationGeneration += 1;
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
    <ContextToolbar class="grid h-auto min-h-16 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-2 px-3 py-2 sm:grid-cols-[auto_minmax(0,1fr)_minmax(10rem,18rem)] sm:gap-x-4 sm:px-5 lg:px-10">
      <div
        class="col-start-1 row-start-1 flex items-center gap-1 justify-self-start"
        role="group"
        aria-label="SubsPlease catalog mode"
      >
        <Button
          variant={mode === 'season' ? 'default' : 'ghost'}
          size="sm"
          class="px-2 text-xs sm:px-3 sm:text-sm"
          aria-pressed={mode === 'season'}
          onclick={() => selectMode('season')}
        >Season</Button>
      </div>

      <div class="col-start-2 row-start-1 justify-self-center">
        {#if mode === 'season'}
          <SeasonNavigator
            season={seasonCatalog.season}
            year={seasonCatalog.year}
            current={selectedIsCurrentSeason}
            ariaLabel="SubsPlease season"
            onPrevious={() => moveSeason(-1)}
            onNext={() => moveSeason(1)}
          />
        {:else}
          <h1 class="rounded-full px-3 py-2.5 text-center text-sm font-semibold text-(--text)/75 sm:px-5">
            Full archive
          </h1>
        {/if}
      </div>

      <InputGroup class="col-span-2 row-start-2 min-w-0 w-full justify-self-end sm:col-span-1 sm:col-start-3 sm:row-start-1">
        <InputGroupAddon><Search class="size-4" /></InputGroupAddon>
        <InputGroupInput
          bind:value={query}
          placeholder={mode === 'season' ? 'Search this season' : 'Search the archive'}
          aria-label={mode === 'season' ? 'Search this season' : 'Search the SubsPlease archive'}
        />
        {#if query}
          <InputGroupAddon align="inline-end">
            <button
              type="button"
              aria-label="Clear search"
              class="grid size-6 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2"
              onclick={() => (query = '')}
            >
              <X class="size-3.5" />
            </button>
          </InputGroupAddon>
        {/if}
      </InputGroup>
    </ContextToolbar>

    <div class="px-5 pb-24 pt-6 sm:px-8 lg:px-10">
      {#if seasonCatalog.providerIndex?.cacheWarning}
        <CatalogNotice kind="warning" title="Saved archive" description={seasonCatalog.providerIndex.cacheWarning} class="mb-5" />
      {/if}
      {#if mode === 'archive'}
        <p class="text-xs text-(--text)/42">
          {#if seasonCatalog.providerLoading && !seasonCatalog.providerIndex}
            Loading the SubsPlease archive…
          {:else}
            {filteredArchiveShows.length} of {archiveShows.length} archive titles
          {/if}
        </p>

        {#if seasonCatalog.scheduleError}
          <CatalogNotice
            kind="warning"
            class="mt-5"
            title="Weekly schedule unavailable"
            description={seasonCatalog.scheduleError}
            actionLabel="Retry schedule"
            onAction={() => void seasonCatalog.refreshSchedule()}
          />
        {/if}

        {#if requestedShowError}
          <CatalogNotice
            kind="warning"
            class="mt-5"
            title="Archive title unavailable"
            description={requestedShowError}
          />
        {/if}

        {#if seasonCatalog.providerLoading && !seasonCatalog.providerIndex}
          <CatalogLoading label="Loading the SubsPlease archive" />
        {:else if seasonCatalog.providerError && !seasonCatalog.providerIndex}
          <CatalogNotice
            kind="error"
            class="mt-8"
            title="SubsPlease archive unavailable"
            description={seasonCatalog.providerError}
            actionLabel="Retry archive"
            onAction={() => void seasonCatalog.refreshProvider()}
          />
        {:else}
          {#if seasonCatalog.providerError}
            <CatalogNotice
              kind="warning"
              class="mt-5"
              title="The archive could not be refreshed"
              description={seasonCatalog.providerError}
              actionLabel="Retry archive"
              onAction={() => void seasonCatalog.refreshProvider()}
            />
          {/if}

          {#if filteredArchiveShows.length}
            <section
              class="mt-7 grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6"
              aria-label="SubsPlease archive titles"
            >
              {#each filteredArchiveShows.slice(0, archiveLimit) as provider (provider.page)}
                {@const scheduled = scheduledProvider(provider.page)}
                {@const entry = libraryEntries.find((candidate) =>
                  libraryEntryMatches(candidate, undefined, provider.page)
                )}
                <AnimePosterCard
                  title={provider.title}
                  imageUrl={archivePosterUrl(provider)}
                  verdict={entry?.discoveryVerdict}
                  bottomLeft="Archive"
                  airingDay={scheduled?.day}
                  airingTime={scheduled?.show.time}
                  onOpen={() => openArchiveShow(provider)}
                />
              {/each}
            </section>
            {#if archiveLimit < filteredArchiveShows.length}
              <div class="mt-8 flex justify-center">
                <Button variant="ghost" onclick={() => (archiveLimit += 60)}>Show more archive titles</Button>
              </div>
            {/if}
          {:else}
            <CatalogNotice
              centered
              title={query ? 'No archive titles match' : 'The SubsPlease archive is empty'}
              description={query
                ? 'Try another archive title.'
                : 'No titles are available from the SubsPlease index.'}
            />
          {/if}
        {/if}
      {:else}
        <p class="flex flex-wrap items-center gap-2 text-xs text-(--text)/42" role="status">
          {#if seasonCatalog.catalogLoading || seasonCatalog.providerLoading}
            Loading confirmed season matches…
          {:else}
            <span>{filteredShows.length} confirmed of {seasonCatalog.catalog?.shows.length ?? 0} season titles</span>
            <CatalogStatusBadge provenance={seasonCatalog.catalog?.provenance} warning={seasonCatalog.catalog?.cacheWarning} />
          {/if}
        </p>

        {#if seasonCatalog.scheduleError}
          <CatalogNotice
            kind="warning"
            class="mt-5"
            title="Weekly schedule unavailable"
            description={seasonCatalog.scheduleError}
            actionLabel="Retry schedule"
            onAction={() => void seasonCatalog.refreshSchedule()}
          />
        {/if}

        {#if seasonCatalog.catalogError}
          <CatalogNotice
            kind="error"
            class="mt-8"
            title="Season catalog unavailable"
            description={seasonCatalog.catalogError}
            actionLabel="Retry catalog"
            secondaryActionLabel="Browse the archive"
            onAction={() => void seasonCatalog.refreshSeason()}
            onSecondaryAction={() => selectMode('archive')}
          />
          {#if seasonCatalog.providerError}
            <CatalogNotice
              kind={seasonCatalog.providerIndex ? 'warning' : 'error'}
              class="mt-4"
              title="SubsPlease archive unavailable"
              description={seasonCatalog.providerError}
              actionLabel="Retry archive"
              onAction={() => void seasonCatalog.refreshProvider()}
            />
          {/if}
        {:else if seasonCatalog.providerError && !seasonCatalog.providerIndex}
          <CatalogNotice
            kind="error"
            class="mt-8"
            title="SubsPlease archive unavailable"
            description={seasonCatalog.providerError}
            actionLabel="Retry archive"
            onAction={() => void seasonCatalog.refreshProvider()}
          />
        {:else if seasonCatalog.catalogLoading ||
          (seasonCatalog.providerLoading && !seasonCatalog.providerIndex)}
          <CatalogLoading
            label={seasonCatalog.catalogLoading
              ? 'Loading season catalog'
              : 'Loading SubsPlease availability'}
          />
        {:else}
          {#if seasonCatalog.providerError}
            <CatalogNotice
              kind="warning"
              class="mt-5"
              title="The archive could not be refreshed"
              description={seasonCatalog.providerError}
              actionLabel="Retry archive"
              onAction={() => void seasonCatalog.refreshProvider()}
            />
          {/if}

          {#if filteredShows.length}
            <section
              class="mt-7 grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6"
              aria-label="Confirmed SubsPlease season matches"
            >
              {#each filteredShows as item (item.anime.id)}
                {@const entry = libraryEntries.find((candidate) =>
                  libraryEntryMatches(candidate, item.anime.id, item.provider.page)
                )}
                <AnimePosterCard
                  title={preferredTitle(item.anime)}
                  imageUrl={posterUrl(item)}
                  verdict={entry?.discoveryVerdict}
                  bottomLeft={item.anime.episodes ? `${item.anime.episodes} eps` : 'Episodes TBA'}
                  airingDay={item.day}
                  airingTime={item.schedule?.time}
                  bottomRight="Archive"
                  onOpen={() => openAvailableShow(item)}
                />
              {/each}
            </section>
          {:else}
            <CatalogNotice
              centered
              title={query ? 'No season titles match' : 'No confirmed SubsPlease matches found'}
              description={query
                ? 'No confirmed seasonal title matches this search.'
                : 'The season catalog loaded, but no title could be confidently matched to the SubsPlease archive.'}
            />
          {/if}
        {/if}
      {/if}
    </div>
  </main>
{/if}
