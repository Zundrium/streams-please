<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { BookOpen, Check, Play, Search, X } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    InputGroup,
    InputGroupAddon,
    InputGroupInput
  } from '$lib/components/ui/input-group';
  import { Slider } from '$lib/components/ui/slider';
  import { Spinner } from '$lib/components/ui/spinner';
  import AnimatedProgress from '$lib/components/shared/AnimatedProgress.svelte';
  import AnimePosterCard from '$lib/components/catalog/AnimePosterCard.svelte';
  import ContextToolbar from '$lib/components/shared/ContextToolbar.svelte';
  import ShowDetailsPage from '$lib/components/catalog/ShowDetailsPage.svelte';
  import {
    CONFIRMED_MATCH_CONFIDENCE,
    loadProviderMappings,
    matchSubsPleaseShow,
    posterUrl,
    preferredTitle,
    saveProviderMapping
  } from '$lib/catalog';
  import { preferredDownload } from '$lib/catalog/media';
  import {
    libraryEntryMatches,
    librarySection,
    nextUnwatchedEpisode,
    resumePosition,
    watchedCount
  } from '$lib/library';
  import { formatPlaybackTime } from '$lib/player/playback-state';
  import type {
    AniListRelationNode,
    DayName,
    DiscoveryVerdict,
    EpisodePlaybackRequest,
    LibraryEntry,
    PlaybackQuality,
    SubsPleaseDownload,
    SubsPleaseIndexResponse,
    SubsPleaseRelease,
    SubsPleaseScheduleShow,
    SubsPleaseShowResponse,
    TrailerPlaybackRequest
  } from '$lib/types';
  import { errorMessage } from '$lib/errors';
  import { localTimezone } from '$lib/time';


  let {
    entries,
    loadIndex,
    loadShow,
    onPlay,
    onPlayTrailer,
    onBrowse,
    onToggleLibrary,
    onSetDiscoveryVerdict,
    onToggleWatched,
    onSetProgress,
    onShowLoaded,
    preferredQuality,
    openSlug = '',
    onOpenConsumed = () => undefined
  }: {
    entries: LibraryEntry[];
    loadIndex: () => Promise<SubsPleaseIndexResponse>;
    loadShow: (
      slug: string,
      timezone: string,
      anilistId?: number,
      includeMetadata?: boolean
    ) => Promise<SubsPleaseShowResponse>;
    onPlay: (request: EpisodePlaybackRequest) => Promise<void>;
    onPlayTrailer: (request: TrailerPlaybackRequest) => void | Promise<void>;
    onBrowse: () => void;
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
    onSetProgress: (slug: string, watchedCount: number) => void;
    onShowLoaded: (
      details: SubsPleaseShowResponse,
      show: SubsPleaseScheduleShow,
      day?: DayName
    ) => void;
    preferredQuality: PlaybackQuality;
    openSlug?: string;
    onOpenConsumed?: () => void;
  } = $props();

  let selectedShow = $state<SubsPleaseScheduleShow | null>(null);
  let selectedDay = $state<DayName | undefined>();
  let detailHistory = $state<Array<{ show: SubsPleaseScheduleShow; day?: DayName }>>([]);
  let refreshing = $state(false);
  let query = $state('');
  let quickPlaySlug = $state('');
  let quickPlayError = $state<{ slug: string; message: string } | null>(null);
  let relationGeneration = 0;
  let disposed = false;
  let libraryShows = $derived(entries.filter((entry) => entry.following));
  let backlogShows = $derived.by(() =>
    entries
      .filter((entry) => librarySection(entry) === 'backlog')
      .toSorted((left, right) =>
        (right.checkedAt ?? right.updatedAt).localeCompare(left.checkedAt ?? left.updatedAt)
      )
  );
  let filteredLibraryShows = $derived(filterEntries(libraryShows, query));
  let filteredAiringShows = $derived(
    filteredLibraryShows.filter((entry) => librarySection(entry) === 'airing')
  );
  let filteredWatchingShows = $derived(
    filteredLibraryShows.filter((entry) => librarySection(entry) === 'watching')
  );
  let filteredCompletedShows = $derived(
    filteredLibraryShows.filter((entry) => librarySection(entry) === 'completed')
  );
  let filteredBacklogShows = $derived(filterEntries(backlogShows, query));
  let selectedLibraryEntry = $derived(
    selectedShow
      ? entries.find(
          (entry) =>
            entry.following &&
            libraryEntryMatches(entry, selectedShow?.anilist_id, selectedShow?.page)
        )
      : undefined
  );
  let selectedDiscoveryVerdict = $derived(
    selectedShow
      ? entries.find((entry) =>
          libraryEntryMatches(entry, selectedShow?.anilist_id, selectedShow?.page)
        )?.discoveryVerdict
      : undefined
  );
  let totalAired = $derived(libraryShows.reduce((total, entry) => total + entry.availableEpisodes.length, 0));
  let totalWatched = $derived(libraryShows.reduce((total, entry) => total + watchedCount(entry), 0));

  onDestroy(() => {
    disposed = true;
    relationGeneration += 1;
  });

  onMount(() => {
    const posterShows = [...libraryShows, ...backlogShows];
    if (!posterShows.length) return;
    let cancelled = false;
    const timezone = localTimezone();
    refreshing = true;
    void Promise.allSettled(
      posterShows.map(async (entry) => {
        const details = await loadShow(entry.slug, timezone, entry.anilistId, false);
        if (!cancelled) onShowLoaded(details, scheduleShow(entry), entry.day);
      })
    ).finally(() => {
      if (!cancelled) refreshing = false;
    });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    const slug = openSlug;
    if (!slug) return;
    const entry = entries.find((item) => item.slug === slug);
    if (!entry) return;
    openEntry(entry);
    onOpenConsumed();
  });

  function filterEntries(items: LibraryEntry[], value: string): LibraryEntry[] {
    const term = value.trim().toLocaleLowerCase();
    if (!term) return items;
    return items.filter((entry) =>
      [entry.title, ...(entry.genres ?? [])].some((text) =>
        text.toLocaleLowerCase().includes(term)
      )
    );
  }

  function scheduleShow(entry: LibraryEntry): SubsPleaseScheduleShow {
    return {
      title: entry.title,
      page: entry.slug,
      image_url: entry.imageUrl,
      time: entry.airingTime ?? '',
      anilist_id: entry.anilistId,
      subsplease_id: entry.subspleaseId
    };
  }

  function openEntry(entry: LibraryEntry) {
    relationGeneration += 1;
    detailHistory = [];
    selectedDay = entry.day;
    selectedShow = scheduleShow(entry);
  }

  function goBack() {
    relationGeneration += 1;
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

  async function openRelatedShow(media: AniListRelationNode): Promise<void> {
    const generation = ++relationGeneration;
    let nextShow: SubsPleaseScheduleShow;
    let nextDay: DayName | undefined;
    const libraryMatch = entries.find((entry) => entry.anilistId === media.id);

    if (libraryMatch) {
      nextShow = scheduleShow(libraryMatch);
      nextDay = libraryMatch.day;
    } else {
      const providerIndex = await loadIndex();
      if (disposed || generation !== relationGeneration) return;
      const match = matchSubsPleaseShow(media, providerIndex.shows, loadProviderMappings());
      if (!match || match.confidence < CONFIRMED_MATCH_CONFIDENCE) {
        throw new Error(`${preferredTitle(media)} is not available in the SubsPlease archive.`);
      }
      saveProviderMapping(media.id, match.provider.page);
      nextShow = {
        title: preferredTitle(media),
        page: match.provider.page,
        image_url: media.coverImage?.extraLarge ?? media.coverImage?.large ?? '',
        time: '',
        anilist_id: media.id
      };
      nextDay = undefined;
    }

    if (disposed || generation !== relationGeneration) return;
    if (selectedShow) {
      detailHistory = [...detailHistory, { show: selectedShow, day: selectedDay }];
    }
    selectedShow = nextShow;
    selectedDay = nextDay;
  }

  async function playNextEpisode(entry: LibraryEntry): Promise<void> {
    const episode = nextUnwatchedEpisode(entry);
    if (!episode || quickPlaySlug) return;

    quickPlaySlug = entry.slug;
    quickPlayError = null;
    try {
      const timezone = localTimezone();
      const show = scheduleShow(entry);
      const details = await loadShow(entry.slug, timezone, entry.anilistId);
      onShowLoaded(details, show, entry.day);
      const release = Object.values(details.episode).find((item) => item.episode === episode);
      if (!release) throw new Error(`Episode ${episode} is no longer available.`);
      const download = preferredDownload(release, preferredQuality);
      if (!download?.magnet) throw new Error(`Episode ${episode} has no playable release.`);

      await onPlay({
        anilistId: details.metadata_id ?? entry.anilistId,
        slug: details.slug || entry.slug,
        title: details.title || entry.title,
        imageUrl: details.image_url || entry.imageUrl,
        episode: release.episode,
        magnet: download.magnet,
        quality: download.res,
        day: entry.day,
        airingTime: entry.airingTime
      });
    } catch (reason) {
      quickPlayError = {
        slug: entry.slug,
        message: errorMessage(reason)
      };
    } finally {
      quickPlaySlug = '';
    }
  }

</script>

{#snippet posterCard(entry: LibraryEntry)}
  {@const watched = watchedCount(entry)}
  {@const aired = entry.availableEpisodes.length}
  {@const waiting = Math.max(0, aired - watched)}
  {@const nextEpisode = nextUnwatchedEpisode(entry)}
  {@const resumeAt = nextEpisode ? resumePosition(entry, nextEpisode) : 0}
  {@const playError = quickPlayError?.slug === entry.slug ? quickPlayError.message : ''}
  <AnimePosterCard
    title={entry.title}
    imageUrl={posterUrl(entry.imageUrl)}
    verdict={entry.discoveryVerdict}
    airingDay={entry.day}
    airingTime={entry.airingTime}
    notice={waiting > 0 ? `${waiting} new` : ''}
    onOpen={() => openEntry(entry)}
  >
    {#snippet bottomLeftContent()}
      {#if nextEpisode}
        <button
          type="button"
          class="pointer-events-auto inline-flex max-w-full items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold shadow-[0_8px_20px_-8px_rgba(0,0,0,0.9)] ring-1 ring-black/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 disabled:cursor-wait disabled:opacity-65 {playError ? 'bg-red-500 text-white hover:bg-red-600' : 'bg-white text-black hover:bg-white/80'}"
          disabled={Boolean(quickPlaySlug)}
          aria-label={playError
            ? `Retry episode ${nextEpisode} of ${entry.title}`
            : resumeAt
              ? `Resume episode ${nextEpisode} of ${entry.title} at ${formatPlaybackTime(resumeAt)}`
              : `Play episode ${nextEpisode} of ${entry.title}`}
          title={playError ||
            (resumeAt
              ? `Resume episode ${nextEpisode} at ${formatPlaybackTime(resumeAt)}`
              : `Play next unwatched episode: ${nextEpisode}`)}
          onclick={() => void playNextEpisode(entry)}
        >
          {#if quickPlaySlug === entry.slug}
            <Spinner class="size-3.5 border-black/20 border-t-black" />
          {:else}
            <Play class="size-3.5" fill="currentColor" />
          {/if}
          <span class="truncate">
            {#if playError}Retry E{nextEpisode}{:else if resumeAt}E{nextEpisode} · {formatPlaybackTime(resumeAt)}{:else}Play E{nextEpisode}{/if}
          </span>
        </button>
        {#if playError}
          <span class="sr-only" role="alert">{entry.title}: {playError}</span>
        {/if}
      {:else}
        <span class="block truncate">{aired ? 'Up to date' : 'Episodes TBA'}</span>
      {/if}
    {/snippet}

    {#snippet posterOverlay()}
      <div class="bg-black/58 px-3 pb-3 pt-2.5 text-white shadow-[0_-10px_28px_-18px_rgba(0,0,0,0.95)] backdrop-blur-md">
        <div class="mb-1.5 flex items-center justify-between gap-2 text-[9px] font-medium tabular-nums text-white/72">
          <span>{watched} / {aired} watched</span>
          {#if waiting === 0}
            <span class="flex items-center gap-1 text-white/88"><Check class="size-2.5" /> Up to date</span>
          {:else}
            <span>{waiting} left</span>
          {/if}
        </div>
        <Slider
          type="single"
          value={watched}
          max={Math.max(aired, 1)}
          step={1}
          disabled={aired === 0}
          aria-label={`Progress for ${entry.title}: ${watched} of ${aired} watched`}
          class="cursor-pointer data-disabled:cursor-default [&_[data-slot=slider-track]]:h-1 [&_[data-slot=slider-track]]:bg-white/22 [&_[data-slot=slider-range]]:bg-chart-1 [&_[data-slot=slider-thumb]]:size-3 [&_[data-slot=slider-thumb]]:border-white/45 [&_[data-slot=slider-thumb]]:bg-white [&_[data-slot=slider-thumb]]:shadow-md"
          onValueCommit={(value) => onSetProgress(entry.slug, Number(value))}
        />
      </div>
    {/snippet}
  </AnimePosterCard>
{/snippet}

{#snippet showSection(id: string, title: string, description: string, shows: LibraryEntry[])}
  {#if shows.length}
    <section class="not-first:mt-16 not-first:border-t not-first:border-(--text)/8 not-first:pt-10" aria-labelledby="{id}-shows-title">
      <div class="flex items-end justify-between gap-6">
        <div>
          <h2 id="{id}-shows-title" class="text-2xl font-semibold tracking-[-0.04em]">{title}</h2>
          <p class="mt-1.5 text-sm text-(--text)/45">{description}</p>
        </div>
        <span class="shrink-0 text-xs font-medium tabular-nums text-(--text)/35">{shows.length} {shows.length === 1 ? 'show' : 'shows'}</span>
      </div>

      <div class="mt-7 grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
        {#each shows as entry (entry.anilistId ?? entry.slug)}
          {@render posterCard(entry)}
        {/each}
      </div>
    </section>
  {/if}
{/snippet}

<main class="h-full min-h-0 overflow-hidden bg-(--bg) text-(--text)">
  {#if selectedShow}
    {#key selectedShow.page}
    <ShowDetailsPage
      show={selectedShow}
      day={selectedDay}
      libraryEntry={selectedLibraryEntry}
      discoveryVerdict={selectedDiscoveryVerdict}
      {loadShow}
      onBack={goBack}
      {onPlay}
      {onPlayTrailer}
      {onToggleLibrary}
      {onSetDiscoveryVerdict}
      {onToggleWatched}
      {onShowLoaded}
      onOpenRelation={openRelatedShow}
      {preferredQuality}
    />
    {/key}
  {:else}
    <section class="h-full min-h-0 overflow-y-auto" aria-label="My library">
      <ContextToolbar class="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-4 sm:gap-8">
        <div class="col-start-1 row-start-1 min-w-0 w-full max-w-sm justify-self-start">
          {#if totalAired}
            <AnimatedProgress
              value={totalWatched}
              max={totalAired}
              remaining={Math.max(0, totalAired - totalWatched)}
              valueLabel="watched"
              color="var(--chart-1)"
              loading={refreshing}
              ariaLabel="Library progress"
              loadingText="Refreshing library progress"
            />
          {/if}
        </div>

        <span class="col-start-2 row-start-1" aria-hidden="true"></span>

        <InputGroup class="col-start-3 row-start-1 min-w-0 w-full max-w-md justify-self-end">
          <InputGroupAddon><Search class="size-4" /></InputGroupAddon>
          <InputGroupInput bind:value={query} placeholder="Search library and backlog" aria-label="Search library and backlog shows" />
          {#if query}
            <InputGroupAddon align="inline-end">
              <button type="button" aria-label="Clear library search" class="grid size-6 place-items-center" onclick={() => (query = '')}>
                <X class="size-3.5" />
              </button>
            </InputGroupAddon>
          {/if}
        </InputGroup>
      </ContextToolbar>

      <div class="px-5 pb-24 pt-8 sm:px-8 lg:px-10">
        {#if query && filteredLibraryShows.length === 0 && filteredBacklogShows.length === 0}
          <div class="grid min-h-[45vh] place-items-center text-center">
            <div class="max-w-sm">
              <Search class="mx-auto size-8 text-(--text)/25" />
              <h2 class="mt-4 text-lg font-medium">No shows found</h2>
              <p class="mt-2 text-sm text-(--text)/42">Try a different title or genre.</p>
            </div>
          </div>
        {:else}
          {#if !query && !libraryShows.length}
            <div class="grid min-h-[28vh] place-items-center text-center">
              <div class="max-w-md">
                <span class="mx-auto grid size-16 place-items-center rounded-full bg-(--text)/6"><BookOpen class="size-7 text-(--text)/45" /></span>
                <h2 class="mt-5 text-2xl font-semibold tracking-[-0.04em]">Your library is still empty</h2>
                <p class="mt-2 text-sm leading-6 text-(--text)/45">
                  {#if backlogShows.length}
                    Open a backlog show below to add it to your library and track its episodes.
                  {:else}
                    Love a show in Discovery, or add one from SubsPlease to keep it here and track its episodes.
                  {/if}
                </p>
                <Button class="mt-6 gap-2" onclick={onBrowse}><Play class="size-4" fill="currentColor" /> Start discovering</Button>
              </div>
            </div>
          {/if}

          {@render showSection('airing', 'Airing', 'Library shows that are still releasing episodes.', filteredAiringShows)}
          {@render showSection('watching', 'Watching', 'Library shows that have finished airing, with episodes you have not watched yet.', filteredWatchingShows)}
          {@render showSection('backlog', 'Backlog', 'Shows you loved or thought looked okay in Discovery, but have not added to your library.', filteredBacklogShows)}
          {@render showSection('completed', 'Completed', 'Library shows that have finished airing, with every episode watched.', filteredCompletedShows)}
        {/if}
      </div>
    </section>
  {/if}
</main>
