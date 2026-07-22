<script lang="ts">
  import { onMount } from 'svelte';
  import {
    Check,
    CheckCircle2,
    Clapperboard,
    Clock3,
    Film,
    Heart,
    Meh,
    Play,
    RectangleHorizontal,
    RefreshCw,
    ThumbsDown,
    Tv2
  } from '@lucide/svelte';
  import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert';
  import { Button } from '$lib/components/ui/button';
  import { Spinner } from '$lib/components/ui/spinner';
  import { isTauri } from '$lib/backend';
  import {
    DAY_ORDER,
    type DayName,
    type DiscoveryVerdict,
    type LibraryEntry,
    type SubsPleaseScheduleResponse,
    type SubsPleaseScheduleShow,
    type SubsPleaseShowResponse,
    type TrailerPlaybackRequest
  } from '$lib/types';

  const SUBSPLEASE_ORIGIN = 'https://subsplease.org';

  let {
    loadSchedule,
    loadShow,
    libraryEntries,
    onDecide,
    onOpenLibrary,
    onPlayTrailer
  }: {
    loadSchedule: (timezone: string) => Promise<SubsPleaseScheduleResponse>;
    loadShow: (slug: string, timezone: string) => Promise<SubsPleaseShowResponse>;
    libraryEntries: LibraryEntry[];
    onDecide: (
      details: SubsPleaseShowResponse,
      show: SubsPleaseScheduleShow,
      day: DayName,
      verdict: DiscoveryVerdict
    ) => void;
    onOpenLibrary: () => void;
    onPlayTrailer: (request: TrailerPlaybackRequest) => void | Promise<void>;
  } = $props();

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Amsterdam';
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: timezone }).format(
    new Date()
  );
  const todayIndex = Math.max(0, DAY_ORDER.indexOf(weekday as DayName));
  const discoveryDayOrder = [
    ...DAY_ORDER.slice(todayIndex),
    ...DAY_ORDER.slice(0, todayIndex)
  ];

  let schedule = $state<SubsPleaseScheduleResponse | null>(null);
  let scheduleLoading = $state(true);
  let scheduleError = $state('');
  let details = $state<SubsPleaseShowResponse | null>(null);
  let detailsLoading = $state(false);
  let detailsError = $state('');
  let detailsRetry = $state(0);
  let trailerTheaterMode = $state(false);
  let metadataSequelSlugs = $state<string[]>([]);

  let allCandidates = $derived.by(() => {
    const seen = new Set<string>();
    return discoveryDayOrder.flatMap((day) =>
      (schedule?.schedule[day] ?? []).flatMap((show) => {
        if (seen.has(show.page) || isObviousSequelTitle(show.title)) return [];
        seen.add(show.page);
        return [{ show, day }];
      })
    );
  });
  let eligibleCandidates = $derived(
    allCandidates.filter(({ show }) => !metadataSequelSlugs.includes(show.page))
  );
  let candidates = $derived.by(() => {
    const checked = new Set(
      libraryEntries.filter((entry) => entry.discoveryVerdict).map((entry) => entry.slug)
    );
    return eligibleCandidates.filter(({ show }) => !checked.has(show.page));
  });
  let currentCandidate = $derived(candidates[0]);
  let reviewedCount = $derived(eligibleCandidates.length - candidates.length);
  let progress = $derived(
    eligibleCandidates.length ? (reviewedCount / eligibleCandidates.length) * 100 : 0
  );
  let embedUrl = $derived.by(() => {
    const trailer = details?.trailer;
    if (!trailer?.id) return '';
    const site = trailer.site.toLowerCase();
    if (site === 'youtube') {
      const parameters = new URLSearchParams({ rel: '0', playsinline: '1' });
      if (typeof window !== 'undefined' && /^https?:\/\//.test(window.location.origin)) {
        parameters.set('origin', window.location.origin);
        parameters.set('widget_referrer', window.location.origin);
      }
      return `https://www.youtube.com/embed/${encodeURIComponent(trailer.id)}?${parameters}`;
    }
    if (site === 'dailymotion') {
      return `https://www.dailymotion.com/embed/video/${encodeURIComponent(trailer.id)}`;
    }
    return '';
  });
  let trailerUrl = $derived.by(() => {
    const trailer = details?.trailer;
    if (!trailer?.id) return '';
    const site = trailer.site.toLowerCase();
    if (site === 'youtube') {
      return `https://www.youtube.com/watch?v=${encodeURIComponent(trailer.id)}`;
    }
    if (site === 'dailymotion') {
      return `https://www.dailymotion.com/video/${encodeURIComponent(trailer.id)}`;
    }
    return '';
  });
  let trailerThumbnail = $derived.by(() => {
    if (details?.trailer?.thumbnail) return details.trailer.thumbnail;
    if (details?.trailer?.site.toLowerCase() === 'youtube' && details.trailer.id) {
      return `https://i.ytimg.com/vi/${encodeURIComponent(details.trailer.id)}/hqdefault.jpg`;
    }
    return '';
  });

  onMount(() => {
    void refreshSchedule();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && trailerTheaterMode) {
        trailerTheaterMode = false;
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, button, iframe')) return;
      if (event.key === '1') decide('love');
      if (event.key === '2') decide('maybe');
      if (event.key === '3') decide('pass');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  $effect(() => {
    const candidate = currentCandidate;
    detailsRetry;
    trailerTheaterMode = false;
    if (!candidate) {
      details = null;
      detailsLoading = false;
      detailsError = '';
      return;
    }

    let cancelled = false;
    details = null;
    detailsLoading = true;
    detailsError = '';
    loadShow(candidate.show.page, timezone)
      .then((nextDetails) => {
        if (cancelled) return;
        if (nextDetails.has_series_prequel) {
          if (!metadataSequelSlugs.includes(candidate.show.page)) {
            metadataSequelSlugs = [...metadataSequelSlugs, candidate.show.page];
          }
          return;
        }
        details = nextDetails;
      })
      .catch((reason) => {
        if (!cancelled) detailsError = reason instanceof Error ? reason.message : String(reason);
      })
      .finally(() => {
        if (!cancelled) detailsLoading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  async function refreshSchedule() {
    scheduleLoading = true;
    scheduleError = '';
    metadataSequelSlugs = [];
    try {
      schedule = await loadSchedule(timezone);
    } catch (reason) {
      scheduleError = reason instanceof Error ? reason.message : String(reason);
    } finally {
      scheduleLoading = false;
    }
  }

  function isObviousSequelTitle(value: string): boolean {
    const title = decodeEntities(value).toLowerCase();
    const numberedMarkers = [
      /\bs\s*(\d+)\b/g,
      /\bseason\s*(\d+)\b/g,
      /\bpart\s*(\d+)\b/g,
      /\bcour\s*(\d+)\b/g,
      /\b(\d+)(?:nd|rd|th)\s+(?:season|part|cour)\b/g
    ];
    if (
      numberedMarkers.some((pattern) =>
        [...title.matchAll(pattern)].some((match) => Number(match[1]) >= 2)
      )
    ) {
      return true;
    }
    return /\b(?:second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:season|part|cour)\b/.test(
      title
    );
  }

  function decide(verdict: DiscoveryVerdict) {
    if (!currentCandidate || !details || detailsLoading) return;
    onDecide(details, currentCandidate.show, currentCandidate.day, verdict);
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

  function metadataLabel(value: string): string {
    return value
      .toLowerCase()
      .replaceAll('_', ' ')
      .replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
  }
</script>

<main class="h-full min-h-0 overflow-y-auto bg-(--bg) text-(--text)" aria-label="Discover airing anime">
  <div class="mx-auto flex min-h-full max-w-[100rem] flex-col px-5 pb-10 pt-7 lg:px-10 lg:pb-12 lg:pt-8">
    <header class="mb-9 flex justify-end">
      {#if allCandidates.length}
        <div class="w-full max-w-sm">
          <div class="mb-2 flex items-center justify-between text-xs text-(--text)/42">
            <span>{reviewedCount} checked</span>
            <span>{candidates.length} left</span>
          </div>
           <div class="h-1.5 overflow-hidden rounded-full bg-(--text)/8" aria-label={`${reviewedCount} of ${eligibleCandidates.length} checked`}>
            <div class="h-full rounded-full bg-chart-4 transition-[width] duration-500" style={`width: ${progress}%`}></div>
          </div>
        </div>
      {/if}
    </header>

    {#if scheduleLoading}
      <section class="grid min-h-[60vh] place-items-center">
        <div class="flex flex-col items-center gap-3 text-sm text-(--text)/45"><Spinner class="size-7" /><b class="text-(--text)/70">Finding your next unchecked show</b></div>
      </section>
    {:else if scheduleError}
      <section class="grid min-h-[60vh] place-items-center">
        <Alert variant="destructive" class="max-w-xl">
          <Tv2 class="size-5" />
          <AlertTitle>Discovery is unavailable</AlertTitle>
          <AlertDescription>{scheduleError}</AlertDescription>
          <Button variant="ghost" size="sm" class="mt-3 gap-2" onclick={() => void refreshSchedule()}><RefreshCw class="size-3.5" /> Try again</Button>
        </Alert>
      </section>
    {:else if !currentCandidate}
      <section class="grid flex-1 place-items-center py-20 text-center">
        <div class="max-w-md">
          <span class="mx-auto grid size-16 place-items-center rounded-full bg-chart-2/12 text-chart-2"><CheckCircle2 class="size-8" /></span>
          <h2 class="mt-5 text-2xl font-semibold tracking-[-0.045em]">You checked every first-season show</h2>
          <p class="mt-2 text-sm leading-6 text-(--text)/45">Your choices are saved in the library. New first-season shows will automatically appear here when the schedule changes.</p>
          <Button class="mt-6 gap-2" onclick={onOpenLibrary}><Check class="size-4" /> View checked shows</Button>
        </div>
      </section>
    {:else}
      <article class="flex flex-1 flex-col">
        <div class="grid items-start gap-8 lg:grid-cols-[15rem_minmax(15rem,0.75fr)_minmax(28rem,1.5fr)]">
          <section aria-label="Poster">
            <div class="aspect-[2/3] w-full overflow-hidden rounded-xl bg-(--text)/5">
              {#if details?.image_url || currentCandidate.show.image_url}
                <img class="size-full object-cover" src={posterUrl(details?.image_url || currentCandidate.show.image_url)} alt={`Poster for ${decodeEntities(details?.title || currentCandidate.show.title)}`} />
              {:else}
                <span class="grid size-full place-items-center"><Film class="size-10 text-(--text)/20" /></span>
              {/if}
            </div>
            <p class="mt-3 flex items-center gap-1.5 text-xs text-(--text)/40"><Clock3 class="size-3.5" /> {currentCandidate.day} · {currentCandidate.show.time}</p>
          </section>

          <section class="flex min-h-[22.5rem] flex-col" aria-labelledby="discovery-title">
            {#if detailsLoading}
              <div class="flex flex-1 items-center gap-3 text-sm text-(--text)/45"><Spinner /> Loading show information…</div>
            {:else if detailsError}
              <Alert variant="destructive"><Tv2 class="size-4" /><AlertTitle>Show details unavailable</AlertTitle><AlertDescription>{detailsError}</AlertDescription><Button variant="ghost" size="sm" class="mt-3 gap-2" onclick={() => (detailsRetry += 1)}><RefreshCw class="size-3.5" /> Try again</Button></Alert>
            {:else if details}
              <p class="text-xs font-medium uppercase tracking-[0.14em] text-(--text)/35">
                {[details.year, details.format ? metadataLabel(details.format) : '', details.status ? metadataLabel(details.status) : ''].filter(Boolean).join(' · ')}
              </p>
              <h2 id="discovery-title" class="mt-4 text-3xl font-semibold leading-[1.02] tracking-[-0.055em]">{decodeEntities(details.title || currentCandidate.show.title)}</h2>
              {#if details.genres?.length}<p class="mt-3 text-xs font-medium text-chart-4">{details.genres.slice(0, 4).join(' · ')}</p>{/if}
              <p class="mt-6 line-clamp-[10] text-sm leading-7 text-(--text)/58">{decodeEntities(details.synopsis || 'No description has been found for this show yet.')}</p>
              <p class="mt-auto pt-6 text-[11px] text-(--text)/30">Show data from {details.metadata_source || 'SubsPlease'}</p>
            {/if}
          </section>

          <section
            class="w-full overflow-hidden bg-black text-white {trailerTheaterMode ? 'fixed inset-0 z-[100] rounded-none' : 'relative aspect-video rounded-xl'}"
            aria-label={trailerTheaterMode ? 'Trailer theater mode' : 'Trailer'}
          >
              {#if embedUrl && !detailsLoading && !isTauri()}
                <Button
                  variant="ghost"
                  size="icon"
                  class="absolute bottom-1.5 right-12 z-10 size-9 bg-black/45 text-white/85 shadow-lg backdrop-blur hover:bg-black/75 hover:text-white aria-pressed:bg-white/20"
                  aria-label={trailerTheaterMode ? 'Close trailer theater mode' : 'Open trailer theater mode'}
                  aria-pressed={trailerTheaterMode}
                  onclick={() => (trailerTheaterMode = !trailerTheaterMode)}
                >
                  <RectangleHorizontal class="size-[1.15rem]" strokeWidth={trailerTheaterMode ? 2.8 : 2} />
                </Button>
              {/if}
              {#if detailsLoading}
                <div class="grid size-full place-items-center"><Spinner class="border-white/20 border-t-white" /></div>
              {:else if trailerUrl && isTauri()}
                <button
                  type="button"
                  class="group relative size-full overflow-hidden text-white"
                  aria-label={`Play trailer for ${decodeEntities(details?.title || currentCandidate.show.title)}`}
                  onclick={() =>
                    void onPlayTrailer({
                      url: trailerUrl,
                      title: `${decodeEntities(details?.title || currentCandidate.show.title)} · Trailer`,
                      thumbnail: trailerThumbnail || undefined
                    })}
                >
                  {#if trailerThumbnail}
                    <img class="size-full object-cover opacity-75 transition duration-300 group-hover:scale-[1.02] group-hover:opacity-90" src={trailerThumbnail} alt="" />
                  {/if}
                  <span class="absolute inset-0 bg-gradient-to-t from-black/65 via-black/10 to-black/20"></span>
                  <span class="absolute inset-0 grid place-items-center">
                    <span class="grid size-16 place-items-center rounded-full bg-white text-black shadow-2xl transition group-hover:scale-105"><Play class="ml-1 size-7" fill="currentColor" /></span>
                  </span>
                  <span class="absolute inset-x-0 bottom-0 px-5 py-4 text-left text-sm font-medium">Play trailer</span>
                </button>
              {:else if embedUrl}
                <iframe
                  class="size-full border-0"
                  src={embedUrl}
                  title={`${decodeEntities(details?.title || currentCandidate.show.title)} trailer`}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  referrerpolicy="strict-origin-when-cross-origin"
                  allowfullscreen
                ></iframe>
              {:else}
                <div class="grid size-full place-items-center px-8 text-center">
                  <div><span class="mx-auto grid size-14 place-items-center rounded-full bg-white/8"><Clapperboard class="size-6 text-white/45" /></span><h3 class="mt-4 font-medium">No trailer found</h3><p class="mt-2 text-sm leading-6 text-white/38">AniList does not have an embeddable trailer for this title yet.</p></div>
                </div>
              {/if}
          </section>
        </div>

        <div class="mt-8 grid grid-cols-1 gap-2 self-end sm:grid-cols-3 xl:min-w-[42rem]">
          <Button size="lg" class="h-12 gap-2 bg-chart-5 text-white hover:bg-chart-5/90" disabled={!details || detailsLoading} onclick={() => decide('love')}><Heart class="size-4" fill="currentColor" /> Love it <kbd class="ml-auto hidden rounded bg-white/15 px-1.5 py-0.5 text-[10px] sm:inline">1</kbd></Button>
          <Button variant="ghost" size="lg" class="h-12 gap-2 bg-chart-3/10 text-chart-3 hover:bg-chart-3/15" disabled={!details || detailsLoading} onclick={() => decide('maybe')}><Meh class="size-4" /> Looks okay <kbd class="ml-auto hidden rounded bg-chart-3/12 px-1.5 py-0.5 text-[10px] sm:inline">2</kbd></Button>
          <Button variant="ghost" size="lg" class="h-12 gap-2 bg-(--text)/5" disabled={!details || detailsLoading} onclick={() => decide('pass')}><ThumbsDown class="size-4 text-(--text)/45" /> Not for me <kbd class="ml-auto hidden rounded bg-(--text)/6 px-1.5 py-0.5 text-[10px] sm:inline">3</kbd></Button>
          </div>
      </article>
    {/if}
  </div>
</main>
