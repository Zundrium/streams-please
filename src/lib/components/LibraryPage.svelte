<script lang="ts">
  import { onMount } from 'svelte';
  import { BookOpen, Check, Film, Heart, Meh, Play, RefreshCw, ThumbsDown } from '@lucide/svelte';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import { Slider } from '$lib/components/ui/slider';
  import ShowDetailsPage from '$lib/components/ShowDetailsPage.svelte';
  import { watchedCount } from '$lib/library';
  import type {
    DayName,
    DiscoveryVerdict,
    EpisodePlaybackRequest,
    LibraryEntry,
    PlaybackQuality,
    SubsPleaseScheduleShow,
    SubsPleaseShowResponse
  } from '$lib/types';

  const SUBSPLEASE_ORIGIN = 'https://subsplease.org';

  let {
    entries,
    loadShow,
    onPlay,
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
    loadShow: (slug: string, timezone: string) => Promise<SubsPleaseShowResponse>;
    onPlay: (request: EpisodePlaybackRequest) => Promise<void>;
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
  let refreshing = $state(false);
  let tasteFilter = $state<'all' | 'love' | 'maybe' | 'pass'>('all');
  let followingEntries = $derived(entries.filter((entry) => entry.following));
  let checkedEntries = $derived.by(() =>
    entries
      .filter((entry) => entry.discoveryVerdict)
      .sort((left, right) => (right.checkedAt ?? '').localeCompare(left.checkedAt ?? ''))
  );
  let filteredCheckedEntries = $derived(
    tasteFilter === 'all'
      ? checkedEntries
      : checkedEntries.filter((entry) => entry.discoveryVerdict === tasteFilter)
  );
  let selectedLibraryEntry = $derived(
    selectedShow
      ? entries.find((entry) => entry.slug === selectedShow?.page && entry.following)
      : undefined
  );
  let selectedDiscoveryVerdict = $derived(
    selectedShow
      ? entries.find((entry) => entry.slug === selectedShow?.page)?.discoveryVerdict
      : undefined
  );
  let totalAired = $derived(followingEntries.reduce((total, entry) => total + entry.availableEpisodes.length, 0));
  let totalWatched = $derived(followingEntries.reduce((total, entry) => total + watchedCount(entry), 0));

  onMount(() => {
    if (!followingEntries.length) return;
    let cancelled = false;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Amsterdam';
    refreshing = true;
    void Promise.allSettled(
      followingEntries.map(async (entry) => {
        const details = await loadShow(entry.slug, timezone);
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
      time: entry.airingTime ?? ''
    };
  }

  function openEntry(entry: LibraryEntry) {
    selectedDay = entry.day;
    selectedShow = scheduleShow(entry);
  }

  function goBack() {
    selectedShow = null;
    selectedDay = undefined;
  }

  function verdictLabel(verdict: LibraryEntry['discoveryVerdict']): string {
    if (verdict === 'love') return 'Love it';
    if (verdict === 'maybe') return 'Looks okay';
    return 'Not for me';
  }

  function verdictClass(verdict: LibraryEntry['discoveryVerdict']): string {
    if (verdict === 'love') return 'bg-chart-5 text-white';
    if (verdict === 'maybe') return 'bg-chart-3 text-white';
    return 'bg-black/60 text-white';
  }

</script>

<main class="h-full min-h-0 overflow-hidden bg-(--bg) text-(--text)">
  {#if selectedShow}
    <ShowDetailsPage
      show={selectedShow}
      day={selectedDay}
      libraryEntry={selectedLibraryEntry}
      discoveryVerdict={selectedDiscoveryVerdict}
      {loadShow}
      onBack={goBack}
      {onPlay}
      {onToggleLibrary}
      {onSetDiscoveryVerdict}
      {onToggleWatched}
      {onShowLoaded}
      {preferredQuality}
    />
  {:else}
    <section class="h-full min-h-0 overflow-y-auto" aria-label="My library">
      <div class="mx-auto max-w-[100rem] px-5 pb-24 pt-12 lg:px-10 lg:pt-16">
        {#if followingEntries.length === 0 && checkedEntries.length === 0}
          <div class="grid min-h-[45vh] place-items-center text-center">
            <div class="max-w-md">
              <span class="mx-auto grid size-16 place-items-center rounded-full bg-(--text)/6"><BookOpen class="size-7 text-(--text)/45" /></span>
              <h2 class="mt-5 text-2xl font-semibold tracking-[-0.04em]">Your library is still empty</h2>
              <p class="mt-2 text-sm leading-6 text-(--text)/45">Start with Discovery to check what looks good, or follow a show from SubsPlease to track its episodes.</p>
              <Button class="mt-6 gap-2" onclick={onBrowse}><Play class="size-4" fill="currentColor" /> Start discovering</Button>
            </div>
          </div>
        {:else}
          {#if followingEntries.length}
          <section aria-labelledby="following-title">
            <div class="mb-7 flex items-end justify-between gap-5">
              <div>
                <p class="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-chart-1">Currently following</p>
                <h2 id="following-title" class="text-2xl font-semibold tracking-[-0.045em]">My shows</h2>
              </div>
              <span class="flex items-center gap-2 text-sm text-(--text)/38">{#if refreshing}<RefreshCw class="size-3.5 animate-spin" /> Updating…{:else}{totalWatched} of {totalAired} episodes watched{/if}</span>
            </div>

            <div class="grid grid-cols-2 gap-x-4 gap-y-10 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-6">
              {#each followingEntries as entry (entry.slug)}
                {@const watched = watchedCount(entry)}
                {@const aired = entry.availableEpisodes.length}
                {@const waiting = Math.max(0, aired - watched)}
                <article class="group min-w-0">
                  <button type="button" class="block w-full text-left" aria-label={`Open ${entry.title}`} onclick={() => openEntry(entry)}>
                    <span class="relative block aspect-[3/4] overflow-hidden rounded-lg bg-(--text)/5 shadow-sm transition duration-300 group-hover:shadow-xl group-focus-visible:ring-2 group-focus-visible:ring-chart-1">
                      {#if entry.imageUrl}
                        <img class="size-full object-cover transition duration-500 group-hover:scale-[1.035]" src={posterUrl(entry.imageUrl)} alt="" loading="lazy" />
                      {:else}
                        <span class="grid size-full place-items-center"><Film class="size-9 text-(--text)/25" /></span>
                      {/if}
                      <span class="absolute inset-0 bg-gradient-to-t from-black/65 via-transparent to-transparent"></span>
                      <span class="absolute left-3 top-3 rounded-full bg-chart-1 px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.13em] text-white shadow-lg">Following</span>
                      {#if waiting > 0}<Badge class="absolute right-3 top-3 bg-black/55 text-white backdrop-blur">{waiting} new</Badge>{/if}
                      <span class="absolute inset-x-4 bottom-4 text-white">
                        <span class="block text-[10px] font-medium uppercase tracking-[0.14em] text-white/55">Progress</span>
                        <strong class="mt-0.5 block text-sm">{watched ? `At episode ${watched}` : 'Not started yet'}</strong>
                      </span>
                    </span>
                  </button>

                  <div class="px-1 pt-3">
                    <button type="button" class="block w-full truncate text-left text-[0.95rem] font-medium tracking-[-0.015em] hover:text-chart-1" onclick={() => openEntry(entry)}>{entry.title}</button>
                    <Slider
                      type="single"
                      value={watched}
                      max={Math.max(aired, 1)}
                      step={1}
                      disabled={aired === 0}
                      aria-label={`Progress for ${entry.title}: ${watched} of ${aired} watched`}
                      class="mt-2 cursor-pointer data-disabled:cursor-default [&_[data-slot=slider-track]]:h-1 [&_[data-slot=slider-track]]:bg-(--text)/8 [&_[data-slot=slider-range]]:bg-chart-1 [&_[data-slot=slider-thumb]]:size-3.5 [&_[data-slot=slider-thumb]]:border-chart-1/20 [&_[data-slot=slider-thumb]]:bg-chart-1"
                      onValueCommit={(value) => onSetProgress(entry.slug, Number(value))}
                    />
                    <div class="mt-2 flex items-center justify-between gap-2">
                      <span class="text-xs tabular-nums text-(--text)/38">{watched} / {aired} watched</span>
                      {#if waiting === 0}
                        <span class="flex items-center gap-1 text-[11px] font-medium text-chart-1"><Check class="size-3" /> Up to date</span>
                      {/if}
                    </div>
                  </div>
                </article>
              {/each}
            </div>
          </section>
          {/if}

          {#if checkedEntries.length}
            <section class={followingEntries.length ? 'mt-20 border-t border-(--text)/8 pt-16' : ''} aria-labelledby="taste-title">
              <div class="mb-7 flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
                <div>
                  <p class="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-chart-4">Taste checks</p>
                  <h2 id="taste-title" class="text-2xl font-semibold tracking-[-0.045em]">Checked shows</h2>
                  <p class="mt-2 text-sm text-(--text)/42">Separate from watched progress · {checkedEntries.length} checked</p>
                </div>
                <div class="no-scrollbar flex gap-1 overflow-x-auto" aria-label="Filter checked shows">
                  {#each [
                    { value: 'all', label: 'All', count: checkedEntries.length },
                    { value: 'love', label: 'Love it', count: checkedEntries.filter((entry) => entry.discoveryVerdict === 'love').length },
                    { value: 'maybe', label: 'Looks okay', count: checkedEntries.filter((entry) => entry.discoveryVerdict === 'maybe').length },
                    { value: 'pass', label: 'Not for me', count: checkedEntries.filter((entry) => entry.discoveryVerdict === 'pass').length }
                  ] as filter}
                    <button type="button" class="shrink-0 rounded-full px-3.5 py-2 text-xs font-medium transition-colors {tasteFilter === filter.value ? 'bg-(--text) text-(--bg)' : 'bg-(--text)/5 text-(--text)/48 hover:bg-(--text)/9 hover:text-(--text)'}" onclick={() => (tasteFilter = filter.value as typeof tasteFilter)}>{filter.label} <span class="ml-1 opacity-55">{filter.count}</span></button>
                  {/each}
                </div>
              </div>

              {#if filteredCheckedEntries.length}
                <div class="grid grid-cols-2 gap-x-4 gap-y-10 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-6">
                  {#each filteredCheckedEntries as entry (entry.slug)}
                    <article class="group min-w-0">
                      <button type="button" class="block w-full text-left" aria-label={`Open ${entry.title}`} onclick={() => openEntry(entry)}>
                        <span class="relative block aspect-[3/4] overflow-hidden rounded-lg bg-(--text)/5 shadow-sm transition duration-300 group-hover:shadow-xl group-focus-visible:ring-2 group-focus-visible:ring-chart-4">
                          {#if entry.imageUrl}
                            <img class="size-full object-cover transition duration-500 group-hover:scale-[1.035]" src={posterUrl(entry.imageUrl)} alt="" loading="lazy" />
                          {:else}
                            <span class="grid size-full place-items-center"><Film class="size-9 text-(--text)/25" /></span>
                          {/if}
                          <span class="absolute inset-0 bg-gradient-to-t from-black/65 via-transparent to-transparent"></span>
                          <span class={`absolute left-3 top-3 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.1em] shadow-lg ${verdictClass(entry.discoveryVerdict)}`}>
                            {#if entry.discoveryVerdict === 'love'}<Heart class="size-3" fill="currentColor" />{:else if entry.discoveryVerdict === 'maybe'}<Meh class="size-3" />{:else}<ThumbsDown class="size-3" />{/if}
                            {verdictLabel(entry.discoveryVerdict)}
                          </span>
                          {#if entry.following}<span class="absolute right-3 top-3 rounded-full bg-chart-1 px-2 py-1 text-[8px] font-semibold uppercase tracking-[0.12em] text-white">Following</span>{/if}
                          <span class="absolute inset-x-4 bottom-4 text-white/65"><span class="block text-[10px] font-medium uppercase tracking-[0.13em]">Checked</span><strong class="mt-0.5 block text-xs text-white">Not a watched status</strong></span>
                        </span>
                      </button>
                      <button type="button" class="mt-3 block w-full truncate px-1 text-left text-[0.95rem] font-medium tracking-[-0.015em] hover:text-chart-4" onclick={() => openEntry(entry)}>{entry.title}</button>
                    </article>
                  {/each}
                </div>
              {:else}
                <p class="rounded-2xl bg-(--text)/4 py-12 text-center text-sm text-(--text)/40">No shows in this flavor yet.</p>
              {/if}
            </section>
          {/if}
        {/if}
      </div>
    </section>
  {/if}
</main>
