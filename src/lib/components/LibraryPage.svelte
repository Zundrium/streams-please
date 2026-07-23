<script lang="ts">
  import { onMount } from 'svelte';
  import { BookOpen, Check, Play, Search, X } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    InputGroup,
    InputGroupAddon,
    InputGroupInput
  } from '$lib/components/ui/input-group';
  import { Slider } from '$lib/components/ui/slider';
  import AnimatedProgress from '$lib/components/AnimatedProgress.svelte';
  import AnimePosterCard from '$lib/components/AnimePosterCard.svelte';
  import ContextToolbar from '$lib/components/ContextToolbar.svelte';
  import ShowDetailsPage from '$lib/components/ShowDetailsPage.svelte';
  import {
    loadProviderMappings,
    matchSubsPleaseShow,
    saveProviderMapping
  } from '$lib/catalog';
  import { libraryEntryMatches, watchedCount } from '$lib/library';
  import type {
    AniListRelationNode,
    DayName,
    DiscoveryVerdict,
    EpisodePlaybackRequest,
    LibraryEntry,
    PlaybackQuality,
    SubsPleaseIndexResponse,
    SubsPleaseScheduleShow,
    SubsPleaseShowResponse,
    TrailerPlaybackRequest
  } from '$lib/types';

  const SUBSPLEASE_ORIGIN = 'https://subsplease.org';

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
      anilistId?: number
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
  let libraryShows = $derived(entries.filter((entry) => entry.following));
  let filteredLibraryShows = $derived.by(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!term) return libraryShows;
    return libraryShows.filter((entry) =>
      [entry.title, ...(entry.genres ?? [])].some((value) =>
        value.toLocaleLowerCase().includes(term)
      )
    );
  });
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

  onMount(() => {
    if (!libraryShows.length) return;
    let cancelled = false;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Amsterdam';
    refreshing = true;
    void Promise.allSettled(
      libraryShows.map(async (entry) => {
        const details = await loadShow(entry.slug, timezone, entry.anilistId);
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

  function posterUrl(path: string): string {
    if (!path) return '';
    return path.startsWith('http')
      ? path
      : `${SUBSPLEASE_ORIGIN}${path.startsWith('/') ? '' : '/'}${path}`;
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
    detailHistory = [];
    selectedDay = entry.day;
    selectedShow = scheduleShow(entry);
  }

  function goBack() {
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
    let nextShow: SubsPleaseScheduleShow;
    let nextDay: DayName | undefined;
    const libraryMatch = entries.find((entry) => entry.anilistId === media.id);

    if (libraryMatch) {
      nextShow = scheduleShow(libraryMatch);
      nextDay = libraryMatch.day;
    } else {
      const providerIndex = await loadIndex();
      const match = matchSubsPleaseShow(media, providerIndex.shows, loadProviderMappings());
      if (!match) {
        throw new Error(`${relatedTitle(media)} is not available in the SubsPlease archive.`);
      }
      saveProviderMapping(media.id, match.provider.page);
      nextShow = {
        title: relatedTitle(media),
        page: match.provider.page,
        image_url: media.coverImage?.extraLarge ?? media.coverImage?.large ?? '',
        time: '',
        anilist_id: media.id
      };
      nextDay = undefined;
    }

    if (selectedShow) {
      detailHistory = [...detailHistory, { show: selectedShow, day: selectedDay }];
    }
    selectedShow = nextShow;
    selectedDay = nextDay;
  }

  function subsPleaseScheduleLabel(entry: LibraryEntry): string {
    if (!entry.airingTime) return 'SP Archive';
    return `SP ${entry.day?.slice(0, 3) ?? ''} ${entry.airingTime}`.trim();
  }

</script>

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
          <InputGroupInput bind:value={query} placeholder="Search my library" aria-label="Search my library" />
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
        {#if libraryShows.length === 0}
          <div class="grid min-h-[45vh] place-items-center text-center">
            <div class="max-w-md">
              <span class="mx-auto grid size-16 place-items-center rounded-full bg-(--text)/6"><BookOpen class="size-7 text-(--text)/45" /></span>
              <h2 class="mt-5 text-2xl font-semibold tracking-[-0.04em]">Your library is still empty</h2>
              <p class="mt-2 text-sm leading-6 text-(--text)/45">Love a show in Discovery, or add one from SubsPlease to keep it here and track its episodes.</p>
              <Button class="mt-6 gap-2" onclick={onBrowse}><Play class="size-4" fill="currentColor" /> Start discovering</Button>
            </div>
          </div>
        {:else}
          {#if filteredLibraryShows.length}
          <section class="mt-7 grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6" aria-label="Saved shows">
              {#each filteredLibraryShows as entry (entry.anilistId ?? entry.slug)}
                {@const watched = watchedCount(entry)}
                {@const aired = entry.availableEpisodes.length}
                {@const waiting = Math.max(0, aired - watched)}
                <AnimePosterCard
                  title={entry.title}
                  imageUrl={posterUrl(entry.imageUrl)}
                  verdict={entry.discoveryVerdict}
                  bottomLeft={aired ? `${aired} eps` : 'Episodes TBA'}
                  bottomRight={subsPleaseScheduleLabel(entry)}
                  notice={waiting > 0 ? `${waiting} new` : ''}
                  onOpen={() => openEntry(entry)}
                >
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
              {/each}
          </section>
          {:else}
            <div class="grid min-h-[45vh] place-items-center text-center">
              <div class="max-w-sm">
                <Search class="mx-auto size-8 text-(--text)/25" />
                <h2 class="mt-4 text-lg font-medium">No shows found</h2>
                <p class="mt-2 text-sm text-(--text)/42">Try a different title or genre.</p>
              </div>
            </div>
          {/if}
        {/if}
      </div>
    </section>
  {/if}
</main>
