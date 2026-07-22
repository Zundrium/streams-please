<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    CheckCircle2,
    CircleHelp,
    Clock3,
    Film,
    Heart,
    Meh,
    Search,
    ThumbsDown,
    Tv2,
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
  import ShowDetailsPage from '$lib/components/ShowDetailsPage.svelte';
  import {
    DAY_ORDER,
    type AniListSearchResult,
    type DayName,
    type DiscoveryVerdict,
    type EpisodePlaybackRequest,
    type LibraryEntry,
    type PlaybackQuality,
    type SubsPleaseScheduleResponse,
    type SubsPleaseScheduleShow,
    type SubsPleaseShowResponse
  } from '$lib/types';

  const SUBSPLEASE_ORIGIN = 'https://subsplease.org';
  const DAY_LABELS: Record<DayName, string> = {
    Monday: 'Monday',
    Tuesday: 'Tuesday',
    Wednesday: 'Wednesday',
    Thursday: 'Thursday',
    Friday: 'Friday',
    Saturday: 'Saturday',
    Sunday: 'Sunday'
  };

  let {
    loadSchedule,
    loadShow,
    searchAnime,
    onPlay,
    libraryEntries,
    onToggleLibrary,
    onSetDiscoveryVerdict,
    onToggleWatched,
    onShowLoaded,
    preferredQuality,
    openSlug = '',
    onOpenConsumed = () => undefined
  }: {
    loadSchedule: (timezone: string) => Promise<SubsPleaseScheduleResponse>;
    loadShow: (slug: string, timezone: string) => Promise<SubsPleaseShowResponse>;
    searchAnime: (query: string) => Promise<AniListSearchResult[]>;
    onPlay: (request: EpisodePlaybackRequest) => Promise<void>;
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
  const weekday = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    timeZone: timezone
  }).format(new Date());
  const today: DayName = DAY_ORDER.includes(weekday as DayName) ? (weekday as DayName) : 'Monday';

  let currentTime = $state(new Date());
  let activeDay = $state<DayName>(today);
  let schedule = $state<SubsPleaseScheduleResponse | null>(null);
  let scheduleError = $state('');
  let scheduleLoading = $state(true);
  let query = $state('');
  let searchResults = $state<AniListSearchResult[]>([]);
  let searchingEnglish = $state(false);
  let selectedShow = $state<SubsPleaseScheduleShow | null>(null);
  let selectedDay = $state<DayName>(today);
  let catalogScroller = $state<HTMLElement>();
  let catalogHeader = $state<HTMLElement>();
  let catalogScrollPosition = 0;
  let initialScrollDone = false;

  let totalMatches = $derived(
    DAY_ORDER.reduce((total, day) => total + showsForDay(day).length, 0)
  );
  let selectedLibraryEntry = $derived(
    selectedShow
      ? libraryEntries.find((entry) => entry.slug === selectedShow?.page && entry.following)
      : undefined
  );
  let selectedDiscoveryVerdict = $derived(
    selectedShow
      ? libraryEntries.find((entry) => entry.slug === selectedShow?.page)?.discoveryVerdict
      : undefined
  );

  onMount(() => {
    void refreshSchedule();
    const clock = window.setInterval(() => (currentTime = new Date()), 30_000);
    return () => window.clearInterval(clock);
  });

  $effect(() => {
    const term = query.trim();
    searchResults = [];
    searchingEnglish = false;
    if (term.length < 2) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchingEnglish = true;
      searchAnime(term)
        .then((results) => {
          if (!cancelled) searchResults = results;
        })
        .catch(() => {
          if (!cancelled) searchResults = [];
        })
        .finally(() => {
          if (!cancelled) searchingEnglish = false;
        });
    }, 280);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  });

  $effect(() => {
    const slug = openSlug;
    const activeSchedule = schedule;
    if (!slug || !activeSchedule) return;
    for (const day of DAY_ORDER) {
      const match = activeSchedule.schedule[day]?.find((candidate) => candidate.page === slug);
      if (!match) continue;
      selectedDay = day;
      selectedShow = match;
      onOpenConsumed();
      return;
    }
  });

  function showsForDay(day: DayName): SubsPleaseScheduleShow[] {
    const shows = schedule?.schedule[day] ?? [];
    const term = query.trim().toLowerCase();
    return term
      ? shows.filter(
          (show) =>
            decodeEntities(show.title).toLowerCase().includes(term) ||
            Boolean(matchingAniListResult(show))
        )
      : shows;
  }

  function releasedToday(show: SubsPleaseScheduleShow, day: DayName): boolean {
    if (day !== today) return false;
    const match = /^(\d{1,2}):(\d{2})$/.exec(show.time.trim());
    if (!match) return false;
    const parts = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      hourCycle: 'h23',
      minute: '2-digit',
      timeZone: timezone
    }).formatToParts(currentTime);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? -1);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? -1);
    return hour * 60 + minute >= Number(match[1]) * 60 + Number(match[2]);
  }

  function verdictLabel(verdict?: DiscoveryVerdict): string {
    if (verdict === 'love') return 'Love';
    if (verdict === 'maybe') return 'OK';
    if (verdict === 'pass') return 'Not for me';
    return 'Unknown';
  }

  function verdictClass(verdict?: DiscoveryVerdict): string {
    if (verdict === 'love') return 'bg-chart-5 text-white';
    if (verdict === 'maybe') return 'bg-chart-3 text-white';
    if (verdict === 'pass') return 'bg-black/72 text-white';
    return 'bg-black/55 text-white/70';
  }

  function normalizeCatalogTitle(value: string): string {
    return decodeEntities(value)
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  function titleSimilarity(sourceValue: string, candidateValue: string): number {
    const source = normalizeCatalogTitle(sourceValue);
    const candidate = normalizeCatalogTitle(candidateValue);
    if (!source || !candidate) return 0;
    const sourceCompact = source.replaceAll(' ', '');
    const candidateCompact = candidate.replaceAll(' ', '');
    if (sourceCompact === candidateCompact) return 1;
    const sourceTokens = new Set(source.split(' '));
    const candidateTokens = new Set(candidate.split(' '));
    const shared = [...sourceTokens].filter((token) => candidateTokens.has(token)).length;
    return (2 * shared) / (sourceTokens.size + candidateTokens.size);
  }

  function matchingAniListResult(show: SubsPleaseScheduleShow): AniListSearchResult | undefined {
    return searchResults.find((result) => {
      const titles = [
        result.title.romaji,
        result.title.english,
        result.title.native,
        ...(result.synonyms ?? [])
      ];
      return titles.some(
        (title) => typeof title === 'string' && titleSimilarity(show.title, title) >= 0.62
      );
    });
  }

  function posterUrl(path: string): string {
    if (!path) return '';
    return path.startsWith('http')
      ? path
      : `${SUBSPLEASE_ORIGIN}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  function decodeEntities(value: string): string {
    if (!value || typeof document === 'undefined') return value;
    const textarea = document.createElement('textarea');
    textarea.innerHTML = value;
    return textarea.value;
  }

  async function refreshSchedule() {
    scheduleLoading = true;
    scheduleError = '';
    try {
      schedule = await loadSchedule(timezone);
    } catch (reason) {
      scheduleError = reason instanceof Error ? reason.message : String(reason);
    } finally {
      scheduleLoading = false;
    }
    if (schedule && !initialScrollDone) {
      await tick();
      initialScrollDone = true;
      scrollToDay(today, 'auto');
    }
  }

  function scrollToDay(day: DayName, behavior: ScrollBehavior = 'smooth') {
    if (!catalogScroller) return;
    const section = catalogScroller.querySelector<HTMLElement>(`[data-day="${day}"]`);
    if (!section) return;
    activeDay = day;
    const headerHeight = catalogHeader?.offsetHeight ?? 0;
    catalogScroller.scrollTo({ top: Math.max(0, section.offsetTop - headerHeight), behavior });
  }

  function updateActiveDay() {
    if (!catalogScroller) return;
    const threshold = catalogScroller.scrollTop + (catalogHeader?.offsetHeight ?? 0) + 48;
    let nextDay: DayName = DAY_ORDER[0];
    for (const day of DAY_ORDER) {
      const section = catalogScroller.querySelector<HTMLElement>(`[data-day="${day}"]`);
      if (section && section.offsetTop <= threshold) nextDay = day;
    }
    activeDay = nextDay;
  }

  function openShow(show: SubsPleaseScheduleShow, day: DayName) {
    catalogScrollPosition = catalogScroller?.scrollTop ?? 0;
    selectedDay = day;
    selectedShow = show;
  }

  async function goBack() {
    selectedShow = null;
    await tick();
    if (catalogScroller) catalogScroller.scrollTop = catalogScrollPosition;
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
    <section class="h-full min-h-0 overflow-y-auto scroll-smooth" bind:this={catalogScroller} onscroll={updateActiveDay} aria-label="Weekly overview">
      <header class="sticky top-0 z-30 border-b border-(--text)/8 bg-(--bg)/92 px-5 py-3 backdrop-blur-xl lg:px-10" bind:this={catalogHeader}>
        <div class="mx-auto flex max-w-[100rem] flex-col gap-3 lg:flex-row lg:items-center">
          <nav class="no-scrollbar flex min-w-0 flex-1 gap-1 overflow-x-auto" aria-label="Days of the week">
            {#each DAY_ORDER as day}
              <button
                type="button"
                class="relative shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-colors {activeDay === day ? 'bg-(--text) text-(--bg)' : 'text-(--text)/48 hover:bg-(--text)/6 hover:text-(--text)'}"
                aria-current={activeDay === day ? 'true' : undefined}
                onclick={() => scrollToDay(day)}
              >
                {DAY_LABELS[day]}
                {#if day === today && activeDay !== day}<span class="absolute left-1/2 top-1 h-1 w-1 -translate-x-1/2 rounded-full bg-(--text)/55" aria-label="Today"></span>{/if}
              </button>
            {/each}
          </nav>
          <InputGroup class="w-full lg:w-72">
            <InputGroupAddon><Search class="size-4" /></InputGroupAddon>
            <InputGroupInput bind:value={query} placeholder="Search Japanese or English titles…" aria-label="Search shows by Japanese or English title" />
            {#if query}
              <InputGroupAddon align="inline-end">
                {#if searchingEnglish}<Spinner class="size-3.5" />{/if}
                <Button variant="ghost" size="icon" class="size-7" aria-label="Clear search" onclick={() => (query = '')}><X class="size-3.5" /></Button>
              </InputGroupAddon>
            {/if}
          </InputGroup>
        </div>
      </header>

      <div class="mx-auto max-w-[100rem] px-5 pb-20 lg:px-10">
        {#if scheduleLoading}
          <div class="grid min-h-[65vh] place-items-center">
            <div class="flex flex-col items-center gap-3 text-sm text-(--text)/45"><Spinner class="size-7" /><b class="text-(--text)/70">Loading weekly schedule</b></div>
          </div>
        {:else if scheduleError}
          <div class="grid min-h-[65vh] place-items-center">
            <Alert variant="destructive" class="max-w-xl">
              <Tv2 class="size-5" />
              <AlertTitle>Weekly schedule unavailable</AlertTitle>
              <AlertDescription>{scheduleError}</AlertDescription>
              <Button variant="ghost" size="sm" class="mt-3" onclick={() => void refreshSchedule()}>Try again</Button>
            </Alert>
          </div>
        {:else if query && totalMatches === 0}
          <div class="grid min-h-[65vh] place-items-center text-center">
            <div class="text-(--text)/42"><Search class="mx-auto size-8" /><h2 class="mt-4 font-medium text-(--text)/70">No shows found</h2><p class="mt-1 text-sm">Try a different search term.</p></div>
          </div>
        {:else}
          {#each DAY_ORDER as day}
            {@const dayShows = showsForDay(day)}
            <section class="scroll-mt-28 py-10 lg:py-14" data-day={day} aria-labelledby={`day-${day}`}>
              <div class="mb-6 flex items-end justify-between gap-4">
                <div>
                  <p class="mb-1 text-[10px] font-medium uppercase tracking-[0.18em] text-(--text)/32">{day === today ? 'Today' : 'Weekly schedule'}</p>
                  <h2 id={`day-${day}`} class="text-2xl font-semibold tracking-[-0.045em]">{DAY_LABELS[day]}</h2>
                </div>
                <span class="text-sm tabular-nums text-(--text)/35">{dayShows.length} shows</span>
              </div>

              {#if dayShows.length}
                <div class="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-6">
                  {#each dayShows as show (show.page)}
                    {@const entry = libraryEntries.find((entry) => entry.slug === show.page)}
                    {@const saved = entry?.following ?? false}
                    {@const verdict = entry?.discoveryVerdict}
                    {@const released = releasedToday(show, day)}
                    <button type="button" class="group min-w-0 text-left" aria-label={`Open ${decodeEntities(show.title)}, releases ${day} at ${show.time || 'time to be announced'}, taste: ${verdictLabel(verdict)}`} onclick={() => openShow(show, day)}>
                      <span class="relative block aspect-[3/4] overflow-hidden rounded-lg bg-(--text)/5 shadow-sm transition duration-300 group-hover:shadow-xl group-focus-visible:ring-2 group-focus-visible:ring-(--text)/40">
                        {#if show.image_url}
                          <img class="size-full object-cover transition duration-500 group-hover:scale-[1.035]" src={posterUrl(show.image_url)} alt="" loading="lazy" />
                        {:else}
                          <span class="grid size-full place-items-center"><Film class="size-9 text-(--text)/25" /></span>
                        {/if}
                        <span class="absolute inset-0 bg-gradient-to-t from-black/22 via-transparent to-transparent opacity-0 transition group-hover:opacity-100"></span>
                        {#if saved}<span class="absolute left-2.5 top-2.5 rounded-full bg-chart-1 px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.13em] text-white shadow-lg">In library</span>{/if}
                        <span class="absolute right-2.5 top-2.5 inline-flex items-center gap-1 rounded-full bg-black/72 px-2.5 py-1 text-[10px] font-semibold tabular-nums text-white shadow-lg backdrop-blur-md">
                          {#if released}<CheckCircle2 class="size-3 text-chart-1" aria-label="Released" />{:else}<Clock3 class="size-3" aria-hidden="true" />{/if}
                          {show.time || 'TBA'}
                        </span>
                        <span class={`absolute bottom-2.5 right-2.5 grid size-8 place-items-center rounded-full shadow-lg backdrop-blur-md ${verdictClass(verdict)}`} title={`Taste: ${verdictLabel(verdict)}`} aria-hidden="true">
                          {#if verdict === 'love'}
                            <Heart class="size-4" fill="currentColor" />
                          {:else if verdict === 'maybe'}
                            <Meh class="size-4" />
                          {:else if verdict === 'pass'}
                            <ThumbsDown class="size-4" />
                          {:else}
                            <CircleHelp class="size-4" />
                          {/if}
                        </span>
                      </span>
                      <strong class="mt-3 block truncate px-1 text-[0.95rem] font-medium tracking-[-0.015em]">{decodeEntities(show.title)}</strong>
                      {#if matchingAniListResult(show)?.title.english}
                        <small class="mt-1 block truncate px-1 text-xs text-(--text)/38">{matchingAniListResult(show)?.title.english}</small>
                      {/if}
                    </button>
                  {/each}
                </div>
              {:else}
                <p class="py-5 text-sm text-(--text)/35">No matches for this day.</p>
              {/if}
            </section>
          {/each}
        {/if}
      </div>
    </section>
  {/if}
</main>
