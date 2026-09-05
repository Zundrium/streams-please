<script lang="ts">
  import { onMount } from 'svelte';
  import { crossfade } from 'svelte/transition';
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
    ThumbsDown
  } from '@lucide/svelte';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import { Switch } from '$lib/components/ui/switch';
  import AnimatedProgress from '$lib/components/shared/AnimatedProgress.svelte';
  import CatalogLoading from '$lib/components/catalog/CatalogLoading.svelte';
  import CatalogNotice from '$lib/components/catalog/CatalogNotice.svelte';
  import SeasonNavigator from '$lib/components/catalog/SeasonNavigator.svelte';
  import ContextToolbar from '$lib/components/shared/ContextToolbar.svelte';
  import RevealFrame from '$lib/components/shared/RevealFrame.svelte';
  import RevealImage from '$lib/components/shared/RevealImage.svelte';
  import { isTauri } from '$lib/backend';
  import { currentSeason, preferredTitle, saveProviderMapping, shiftSeason } from '$lib/catalog';
  import { createSeasonCatalog } from '$lib/catalog/season.svelte';
  import { catalogSourceLabel } from '$lib/catalog/providers';
  import CatalogStatusBadge from '$lib/components/catalog/CatalogStatusBadge.svelte';
  import { libraryEntryMatches } from '$lib/library';
  import { youtubeTrailerSearchPlaybackUrl } from '$lib/trailers';
  import {
    type AnimeSeason,
    type AniListSeasonResponse,
    type AniListSeasonShow,
    type DayName,
    type DiscoveryVerdict,
    type LibraryEntry,
    type SubsPleaseIndexResponse,
    type SubsPleaseScheduleResponse,
    type SubsPleaseScheduleShow,
    type SubsPleaseShowResponse,
    type TrailerPlaybackRequest
  } from '$lib/types';

  const SUBSPLEASE_ORIGIN = 'https://subsplease.org';
  const TEXT_REVEAL_DURATION_MS = 360;
  const SEASON_ORDER: AnimeSeason[] = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];

  interface DiscoveryCandidate {
    anime: AniListSeasonShow;
    show: SubsPleaseScheduleShow;
    season: AnimeSeason;
    year: number;
    day?: DayName;
  }

  let {
    loadSeason,
    loadIndex,
    loadSchedule,
    loadShow,
    libraryEntries,
    onDecide,
    onOpenLibrary,
    onPlayTrailer,
    onCloseTrailer
  }: {
    loadSeason: (season: AnimeSeason, year: number) => Promise<AniListSeasonResponse>;
    loadIndex: () => Promise<SubsPleaseIndexResponse>;
    loadSchedule: (timezone: string) => Promise<SubsPleaseScheduleResponse>;
    loadShow: (
      slug: string,
      timezone: string,
      anilistId?: number
    ) => Promise<SubsPleaseShowResponse>;
    libraryEntries: LibraryEntry[];
    onDecide: (
      details: SubsPleaseShowResponse,
      show: SubsPleaseScheduleShow,
      day: DayName | undefined,
      verdict: DiscoveryVerdict
    ) => void | Promise<void>;
    onOpenLibrary: () => void;
    onPlayTrailer: (request: TrailerPlaybackRequest) => void | Promise<void>;
    onCloseTrailer: () => void | Promise<void>;
  } = $props();

  const [sendCandidate, receiveCandidate] = crossfade({
    duration: () =>
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 0
        : 280
  });

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Amsterdam';
  const initialSeason = currentSeason();
  const furthestSeason = shiftSeason(initialSeason.season, initialSeason.year, 1);

  const seasonCatalog = createSeasonCatalog({
    loadSeason: (season, year) => loadSeason(season, year),
    loadIndex: () => loadIndex(),
    loadSchedule: (requestedTimezone) => loadSchedule(requestedTimezone),
    timezone,
    initialSeason
  });

  let selectedSeason = $derived(seasonCatalog.season);
  let selectedYear = $derived(seasonCatalog.year);
  let presentedCandidate = $state<DiscoveryCandidate | null>(null);
  let details = $state<SubsPleaseShowResponse | null>(null);
  let loadedCandidateKey = $state('');
  let mediaRevealCandidateKey = $state('');
  let detailsLoading = $state(false);
  let detailsError = $state('');
  let failedCandidateKey = $state('');
  let detailsRetry = $state(0);
  let trailerTheaterMode = $state(false);
  let autoplay = $state(false);
  let autoplayedCandidateKey = $state('');
  let autoplayingCandidateKey = $state('');
  let metadataSequelSlugs = $state<string[]>([]);
  let discoveryPageElement = $state<HTMLElement | null>(null);
  let trailerSurface = $state<HTMLElement | null>(null);
  let decisionPending = $state(false);

  let selectedIsCurrentSeason = $derived(
    selectedSeason === initialSeason.season && selectedYear === initialSeason.year
  );
  let canMoveNext = $derived(
    seasonOrdinal(selectedSeason, selectedYear) <
      seasonOrdinal(furthestSeason.season, furthestSeason.year)
  );
  let discoveryLoading = $derived(
    seasonCatalog.catalogLoading || seasonCatalog.providerLoading
  );
  let discoveryError = $derived(seasonCatalog.catalogError || seasonCatalog.providerError);
  let allCandidates = $derived.by((): DiscoveryCandidate[] =>
    seasonCatalog.seasonMatches.flatMap((match): DiscoveryCandidate[] => {
      const anime = match.anime;
      if (hasSeriesPrequel(anime) || isObviousSequelTitle(preferredTitle(anime))) return [];
      return [{
        anime,
        show: {
          title: preferredTitle(anime),
          page: match.provider.page,
          image_url: posterUrl(
            anime.coverImage?.extraLarge ??
              anime.coverImage?.large ??
              match.schedule?.image_url ??
              ''
          ),
          time: match.schedule?.time ?? '',
          anilist_id: anime.id,
          subsplease_id: match.schedule?.subsplease_id
        },
        season: selectedSeason,
        year: selectedYear,
        day: match.day
      }];
    })
  );
  let eligibleCandidates = $derived(
    allCandidates.filter(({ show }) => !metadataSequelSlugs.includes(show.page))
  );
  let candidates = $derived.by(() => {
    const checked = libraryEntries.filter((entry) => entry.discoveryVerdict);
    return eligibleCandidates.filter(
      ({ anime, show }) =>
        !checked.some((entry) => libraryEntryMatches(entry, anime.id, show.page))
    );
  });
  let currentCandidate = $derived(candidates[0]);
  let currentCandidateKey = $derived(candidateKey(currentCandidate));
  let presentedCandidateKey = $derived(candidateKey(presentedCandidate));
  let presentedDetailsReady = $derived(
    Boolean(presentedCandidate) && loadedCandidateKey === presentedCandidateKey && details !== null
  );
  let detailsReady = $derived(
    !detailsLoading &&
      presentedDetailsReady &&
      Boolean(currentCandidateKey) &&
      currentCandidateKey === presentedCandidateKey
  );
  let candidateTransitioning = $derived(
    Boolean(currentCandidateKey) && currentCandidateKey !== presentedCandidateKey
  );
  let visibleDetailsError = $derived(
    failedCandidateKey === currentCandidateKey ? detailsError : ''
  );
  let mediaRevealReady = $derived(
    presentedDetailsReady && mediaRevealCandidateKey === presentedCandidateKey
  );
  let reviewedCount = $derived(eligibleCandidates.length - candidates.length);
  let progressRevealReady = $derived(
    !discoveryLoading && !discoveryError && eligibleCandidates.length > 0
  );
  let baseEmbedUrl = $derived.by(() => {
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
  let embedUrl = $derived(
    baseEmbedUrl && autoplayedCandidateKey === presentedCandidateKey
      ? `${baseEmbedUrl}${baseEmbedUrl.includes('?') ? '&' : '?'}autoplay=1&mute=1`
      : baseEmbedUrl
  );
  let trailerUrl = $derived.by(() => {
    if (!details) return '';
    if (isTauri()) return youtubeTrailerSearchPlaybackUrl(details.title);
    const trailer = details.trailer;
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
    return details?.banner_image_url || posterUrl(details?.image_url || '');
  });

  onMount(() => {
    void seasonCatalog.load();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && trailerTheaterMode) {
        trailerTheaterMode = false;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      seasonCatalog.dispose();
      window.removeEventListener('keydown', onKeyDown);
    };
  });

  $effect(() => {
    const page = discoveryPageElement;
    selectedSeason;
    selectedYear;
    if (!page) return;

    page.scrollTop = 0;
    const frame = window.requestAnimationFrame(() => {
      page.scrollTop = 0;
    });
    return () => window.cancelAnimationFrame(frame);
  });

  $effect(() => {
    const candidate = currentCandidate;
    const key = currentCandidateKey;
    detailsRetry;
    trailerTheaterMode = false;

    if (!candidate || !key) {
      const hadPresentedCandidate = Boolean(presentedCandidate);
      presentedCandidate = null;
      details = null;
      loadedCandidateKey = '';
      detailsLoading = false;
      detailsError = '';
      failedCandidateKey = '';
      if (hadPresentedCandidate) void onCloseTrailer();
      return;
    }

    if (key === presentedCandidateKey && presentedDetailsReady) {
      presentedCandidate = candidate;
      detailsLoading = false;
      detailsError = '';
      failedCandidateKey = '';
      return;
    }

    let cancelled = false;
    detailsLoading = true;
    detailsError = '';
    failedCandidateKey = '';
    requestCandidateDetails(candidate)
      .then((nextDetails) => {
        if (cancelled || currentCandidateKey !== key) return;
        if (nextDetails.has_series_prequel) {
          excludeMetadataSequel(candidate.show.page);
          return;
        }
        presentedCandidate = candidate;
        details = nextDetails;
        loadedCandidateKey = key;
      })
      .catch((reason) => {
        if (!cancelled && currentCandidateKey === key) {
          detailsError = reason instanceof Error ? reason.message : String(reason);
          failedCandidateKey = key;
        }
      })
      .finally(() => {
        if (!cancelled && currentCandidateKey === key) detailsLoading = false;
      });

    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    const key = presentedCandidateKey;
    if (!presentedDetailsReady || !key) {
      mediaRevealCandidateKey = '';
      return;
    }

    const timer = window.setTimeout(() => {
      if (presentedCandidateKey === key && loadedCandidateKey === key) {
        mediaRevealCandidateKey = key;
      }
    }, TEXT_REVEAL_DURATION_MS);

    return () => window.clearTimeout(timer);
  });

  $effect(() => {
    const key = presentedCandidateKey;
    const desktop = isTauri();
    if (
      !autoplay ||
      !detailsReady ||
      !details ||
      !key ||
      autoplayedCandidateKey === key ||
      autoplayingCandidateKey === key ||
      (desktop ? !trailerUrl || !trailerSurface?.isConnected : !baseEmbedUrl)
    ) {
      return;
    }

    if (!desktop) {
      autoplayedCandidateKey = key;
      return;
    }

    autoplayingCandidateKey = key;
    void Promise.resolve(
      onPlayTrailer({
        url: trailerUrl,
        title: `${decodeEntities(details.title)} · Trailer`,
        thumbnail: trailerThumbnail || undefined,
        viewport: trailerSurface || undefined
      })
    )
      .then(() => {
        if (presentedCandidateKey === key) autoplayedCandidateKey = key;
      })
      .catch(() => undefined)
      .finally(() => {
        if (autoplayingCandidateKey === key) autoplayingCandidateKey = '';
      });
  });

  function candidateKey(candidate: DiscoveryCandidate | null | undefined): string {
    return candidate
      ? `${candidate.season}:${candidate.year}:${candidate.anime.id}:${candidate.show.page}`
      : '';
  }

  function requestCandidateDetails(
    candidate: DiscoveryCandidate
  ): Promise<SubsPleaseShowResponse> {
    return loadShow(candidate.show.page, timezone, candidate.anime.id);
  }

  function excludeMetadataSequel(slug: string): void {
    if (!metadataSequelSlugs.includes(slug)) {
      metadataSequelSlugs = [...metadataSequelSlugs, slug];
    }
  }

  function moveSeason(amount: number): void {
    if (amount > 0 && !canMoveNext) return;
    const next = shiftSeason(selectedSeason, selectedYear, amount);
    if (
      seasonOrdinal(next.season, next.year) >
      seasonOrdinal(furthestSeason.season, furthestSeason.year)
    ) {
      return;
    }
    seasonCatalog.selectSeason(next.season, next.year);
  }

  function seasonOrdinal(season: AnimeSeason, year: number): number {
    return year * SEASON_ORDER.length + SEASON_ORDER.indexOf(season);
  }

  function seasonLabel(season: AnimeSeason): string {
    return `${season[0]}${season.slice(1).toLowerCase()}`;
  }

  function hasSeriesPrequel(show: AniListSeasonShow): boolean {
    return (show.relations?.edges ?? []).some(
      (edge) =>
        edge.relationType === 'PREQUEL' &&
        edge.node?.type === 'ANIME' &&
        ['TV', 'TV_SHORT', 'ONA'].includes(edge.node.format ?? '')
    );
  }

  function candidateTiming(candidate: DiscoveryCandidate): string {
    if (candidate.day && candidate.show.time) {
      return `${candidate.day} · ${candidate.show.time}`;
    }
    const { year, month, day } = candidate.anime.startDate ?? {};
    if (year && month && day) {
      return new Intl.DateTimeFormat('en-US', {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      }).format(new Date(year, month - 1, day));
    }
    return `${seasonLabel(candidate.season)} ${candidate.year}`;
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

  async function decide(verdict: DiscoveryVerdict) {
    const candidate = presentedCandidate;
    const selectedDetails = details;
    if (!candidate || !selectedDetails || !detailsReady || decisionPending) return;

    decisionPending = true;
    saveProviderMapping(candidate.anime.id, candidate.show.page);
    try {
      await Promise.all([
        onDecide(selectedDetails, candidate.show, candidate.day, verdict),
        !autoplay && isTauri() ? onCloseTrailer() : undefined
      ]);
    } finally {
      decisionPending = false;
    }
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

<main
  bind:this={discoveryPageElement}
  class="h-full min-h-0 overflow-x-clip overflow-y-auto text-(--text)"
  style="overflow-anchor: none"
  data-content-state={discoveryError || visibleDetailsError ? 'error' : discoveryLoading || (currentCandidate && !detailsReady) ? 'loading' : mediaRevealReady ? 'media-enabled' : 'text-ready'}
  aria-label="Discover seasonal anime"
>
  <ContextToolbar class="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-4 sm:gap-8">
    <div class="col-start-1 row-start-1 min-w-0 w-full max-w-sm justify-self-start">
      {#if !discoveryError && (discoveryLoading || eligibleCandidates.length)}
        <AnimatedProgress
          value={reviewedCount}
          max={eligibleCandidates.length}
          remaining={candidates.length}
          valueLabel="checked"
          color="var(--chart-4)"
          loading={!progressRevealReady}
          ariaLabel="Discovery progress"
          loadingText="Loading discovery progress"
        />
      {/if}
    </div>

    <SeasonNavigator
      season={selectedSeason}
      year={selectedYear}
      current={selectedIsCurrentSeason}
      {canMoveNext}
      nextTitle={canMoveNext ? 'Next season' : 'Discovery looks up to one season ahead'}
      ariaLabel="Discovery season"
      onPrevious={() => moveSeason(-1)}
      onNext={() => moveSeason(1)}
    />

    <label class="col-start-3 row-start-1 flex items-center gap-2.5 justify-self-end text-sm font-medium text-(--text)/70">
      <span>Autoplay</span>
      <Switch
        class="focus-visible:ring-2 focus-visible:ring-(--text)/24"
        checked={autoplay}
        aria-label="Autoplay trailers"
        onCheckedChange={(checked) => (autoplay = checked)}
      />
    </label>
  </ContextToolbar>

  <div class="relative mx-auto flex min-h-[calc(100%_-_4rem)] max-w-[100rem] flex-col px-5 py-7 lg:px-10 lg:py-8">
    {#if seasonCatalog.catalog?.provenance}
      <p class="mb-4 flex flex-wrap items-center gap-2 text-xs text-(--text)/45" role="status">
        <span>{catalogSourceLabel(seasonCatalog.catalog.provenance)}</span>
        <CatalogStatusBadge provenance={seasonCatalog.catalog.provenance} warning={seasonCatalog.catalog.cacheWarning} />
      </p>
    {/if}
    {#if seasonCatalog.providerIndex?.cacheWarning}
      <CatalogNotice kind="warning" title="Saved archive" description={seasonCatalog.providerIndex.cacheWarning} class="mb-6" />
    {/if}
    {#if seasonCatalog.scheduleError}
      <CatalogNotice
        kind="warning"
        class="mb-6"
        title="Schedule times unavailable"
        description={seasonCatalog.scheduleError}
        actionLabel="Retry schedule"
        onAction={() => void seasonCatalog.refreshSchedule()}
      />
    {/if}

    {#if seasonCatalog.catalogError || seasonCatalog.providerError}
      <section class="grid min-h-[60vh] place-items-center">
        <div class="w-full max-w-xl space-y-4">
          {#if seasonCatalog.catalogError}
            <CatalogNotice
              kind="error"
              title="Season catalog unavailable"
              description={seasonCatalog.catalogError}
              actionLabel="Retry catalog"
              onAction={() => void seasonCatalog.refreshSeason()}
            />
          {/if}
          {#if seasonCatalog.providerError}
            <CatalogNotice
              kind="error"
              title="SubsPlease archive unavailable"
              description={seasonCatalog.providerError}
              actionLabel="Retry archive"
              onAction={() => void seasonCatalog.refreshProvider()}
            />
          {/if}
        </div>
      </section>
    {:else if discoveryLoading}
      <CatalogLoading
        class="min-h-[60vh]"
        label={`Finding shows for ${seasonLabel(selectedSeason)} ${selectedYear}`}
      />
    {:else if currentCandidate && !presentedDetailsReady && !visibleDetailsError}
      <CatalogLoading class="min-h-[60vh]" label="Loading the next show" />
    {:else if currentCandidate && !presentedDetailsReady && visibleDetailsError}
      <section class="grid min-h-[60vh] place-items-center">
        <CatalogNotice
          kind="error"
          centered
          title="Show details unavailable"
          description={visibleDetailsError}
          actionLabel="Try again"
          onAction={() => (detailsRetry += 1)}
        />
      </section>
    {:else if !currentCandidate}
      <section class="grid flex-1 place-items-center py-20 text-center">
        <div class="max-w-md">
          {#if eligibleCandidates.length}
            <span class="mx-auto grid size-16 place-items-center rounded-full bg-chart-2/12 text-chart-2"><CheckCircle2 class="size-8" /></span>
            <h2 class="mt-5 text-2xl font-semibold tracking-[-0.045em]">You checked every new show in {seasonLabel(selectedSeason)} {selectedYear}</h2>
            <p class="mt-2 text-sm leading-6 text-(--text)/45">Your choices are saved in the library. You can revisit another season or review the shows you kept.</p>
            <Button class="mt-6 gap-2" onclick={onOpenLibrary}><Check class="size-4" /> View checked shows</Button>
          {:else}
            <span class="mx-auto grid size-16 place-items-center rounded-full bg-(--text)/6 text-(--text)/35"><Film class="size-8" /></span>
            <h2 class="mt-5 text-2xl font-semibold tracking-[-0.045em]">Nothing discoverable yet</h2>
            <p class="mt-2 text-sm leading-6 text-(--text)/45">No new-series titles from {seasonLabel(selectedSeason)} {selectedYear} are available in the SubsPlease archive yet. Try a nearby season.</p>
          {/if}
        </div>
      </section>
    {:else if presentedDetailsReady && presentedCandidate && details}
      <article class="flex flex-1 flex-col py-3 lg:py-5" aria-busy={candidateTransitioning}>
        <div class="grid">
          {#key presentedCandidateKey}
            {@const titleId = `discovery-title-${presentedCandidate.anime.id}`}
            <header
              class="col-start-1 row-start-1 flex items-start gap-4"
              aria-labelledby={titleId}
              in:receiveCandidate={{ key: 'candidate-header' }}
              out:sendCandidate={{ key: 'candidate-header' }}
            >
              <div class="media-placeholder aspect-[3/4] w-14 shrink-0 overflow-hidden rounded-lg sm:w-16">
                {#if details.image_url}
                  <RevealImage class="size-full object-cover" src={posterUrl(details.image_url)} alt="" loading="eager" fetchpriority="high" reveal={mediaRevealReady} />
                {:else}
                  <span class="grid size-full place-items-center"><Film class="size-5 text-(--text)/20" /></span>
                {/if}
              </div>
              <div class="min-w-0 pt-0.5">
                <h2 id={titleId} class="text-3xl font-semibold leading-[1.02] tracking-[-0.055em] lg:text-4xl">{decodeEntities(details.title)}</h2>
                <div class="mt-3 flex flex-wrap gap-2" aria-label="Show tags and details">
                  {#each details.genres?.slice(0, 4) ?? [] as genre (genre)}
                    <Badge class="bg-blue-500/12 text-blue-600 ring-1 ring-inset ring-blue-500/15 dark:text-blue-300">{genre}</Badge>
                  {/each}
                  {#if details.year}<Badge class="bg-(--text)/6 text-(--text)/58">{details.year}</Badge>{/if}
                  {#if details.format}<Badge class="bg-(--text)/6 text-(--text)/58">{metadataLabel(details.format)}</Badge>{/if}
                  {#if details.status}<Badge class="bg-(--text)/6 text-(--text)/58">{metadataLabel(details.status)}</Badge>{/if}
                  <Badge class="bg-(--text)/6 text-(--text)/58"><Clock3 class="size-3" /> {candidateTiming(presentedCandidate)}</Badge>
                </div>
              </div>
            </header>
          {/key}
        </div>

        {#if candidateTransitioning}
          <span class="sr-only" role="status">Loading the next show</span>
        {/if}

        <div
          bind:this={trailerSurface}
          class="mt-6 {trailerTheaterMode ? 'fixed inset-0 z-[100]' : 'relative aspect-video w-full overflow-hidden bg-black text-white ring-1 ring-white/10'}"
        >
          <section
            class="size-full overflow-hidden bg-black text-white"
            aria-label={trailerTheaterMode ? 'Trailer theater mode' : 'Trailer'}
          >
            {#if embedUrl && !isTauri()}
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
            {#if trailerUrl && isTauri()}
              <button
                type="button"
                class="group relative size-full overflow-hidden text-white"
                aria-label={`Play trailer for ${decodeEntities(details.title)}`}
                onclick={() =>
                  void onPlayTrailer({
                    url: trailerUrl,
                    title: `${decodeEntities(details?.title ?? '')} · Trailer`,
                    thumbnail: trailerThumbnail || undefined,
                    viewport: trailerSurface || undefined
                  })}
              >
                {#if trailerThumbnail}
                  <RevealImage class="size-full object-cover opacity-75 transition duration-300 group-hover:scale-[1.02] group-hover:opacity-90" src={trailerThumbnail} alt="" reveal={mediaRevealReady} />
                {/if}
                <span class="absolute inset-0 bg-gradient-to-t from-black/65 via-black/10 to-black/20"></span>
                <span class="absolute inset-0 grid place-items-center">
                  <span class="grid size-16 place-items-center rounded-full bg-white text-black shadow-2xl transition group-hover:scale-105"><Play class="ml-1 size-7" fill="currentColor" /></span>
                </span>
                <span class="absolute inset-x-0 bottom-0 px-5 py-4 text-left text-sm font-medium">Play trailer</span>
              </button>
            {:else if embedUrl}
              <RevealFrame
                class="size-full border-0"
                src={embedUrl}
                title={`${decodeEntities(details.title)} trailer`}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                referrerpolicy="strict-origin-when-cross-origin"
                allowfullscreen
                reveal={mediaRevealReady}
              />
            {:else}
              <div class="grid size-full place-items-center px-8 text-center">
                <div><span class="mx-auto grid size-14 place-items-center rounded-full bg-white/8"><Clapperboard class="size-6 text-white/45" /></span><h3 class="mt-4 font-medium">No trailer found</h3><p class="mt-2 text-sm leading-6 text-white/38">The desktop app can search YouTube for a subtitled trailer.</p></div>
              </div>
            {/if}
          </section>
        </div>

        {#if visibleDetailsError}
          <CatalogNotice
            kind="error"
            class="mt-6"
            title="The next show could not load"
            description={visibleDetailsError}
            actionLabel="Try again"
            onAction={() => (detailsRetry += 1)}
          />
        {:else}
        <div class="mt-6 grid w-full grid-cols-1 gap-3 sm:grid-cols-3">
          <Button
            size="lg"
            class="reaction-button love-button group relative h-20 justify-start overflow-hidden rounded-full bg-emerald-500 px-5 text-white shadow-[0_18px_42px_-24px_rgba(16,185,129,0.95)] hover:bg-emerald-400 sm:h-[5.25rem] sm:px-6 dark:bg-emerald-500 dark:hover:bg-emerald-400"
            disabled={decisionPending || candidateTransitioning}
            onclick={() => void decide('love')}
          >
            <span class="love-heart grid size-11 shrink-0 place-items-center rounded-full bg-white text-pink-500 shadow-sm"><Heart class="size-6" fill="currentColor" strokeWidth={2.5} /></span>
            <span class="ml-3.5 flex flex-col items-start">
              <strong class="text-base font-semibold tracking-[-0.025em] sm:text-lg">Love it</strong>
              <small class="text-xs font-medium text-white/70">Add to my library</small>
            </span>
          </Button>

          <Button
            variant="ghost"
            size="lg"
            class="reaction-button maybe-button group relative h-20 justify-start overflow-hidden rounded-full bg-amber-400 px-5 text-white shadow-[0_18px_42px_-24px_rgba(245,158,11,0.95)] hover:bg-amber-300 hover:text-white sm:h-[5.25rem] sm:px-6 dark:bg-amber-400 dark:text-white dark:hover:bg-amber-300"
            disabled={decisionPending || candidateTransitioning}
            onclick={() => void decide('maybe')}
          >
            <span class="maybe-face grid size-11 shrink-0 place-items-center rounded-full bg-white text-amber-400 shadow-sm"><Meh class="size-6" strokeWidth={2.5} /></span>
            <span class="ml-3.5 flex flex-col items-start">
              <span class="flex items-end">
                <strong class="text-base font-semibold tracking-[-0.025em] sm:text-lg">Looks okay</strong>
                <span class="maybe-dots ml-1.5 mb-1 flex items-center gap-1" aria-hidden="true">
                  <i></i><i></i><i></i>
                </span>
              </span>
              <small class="text-xs font-medium text-white/75">Maybe I’ll try it</small>
            </span>
          </Button>

          <Button
            variant="ghost"
            size="lg"
            class="reaction-button pass-button group relative h-20 justify-start overflow-hidden rounded-full bg-red-500 px-5 text-white shadow-[0_18px_42px_-24px_rgba(239,68,68,0.95)] hover:bg-red-400 hover:text-white sm:h-[5.25rem] sm:px-6 dark:bg-red-500 dark:text-white dark:hover:bg-red-400"
            disabled={decisionPending || candidateTransitioning}
            onclick={() => void decide('pass')}
          >
            <span class="pass-thumb grid size-11 shrink-0 place-items-center rounded-full bg-white text-red-500 shadow-sm"><ThumbsDown class="size-6" strokeWidth={2.5} /></span>
            <span class="ml-3.5 flex flex-col items-start">
              <strong class="text-base font-semibold tracking-[-0.025em] sm:text-lg">Not for me</strong>
              <small class="text-xs font-medium text-white/70">Hard pass</small>
            </span>
          </Button>
        </div>
        {/if}
      </article>
    {/if}
  </div>
</main>

<style>
  :global(.reaction-button) {
    isolation: isolate;
    transition:
      transform 240ms var(--ease-spring),
      box-shadow 240ms ease,
      background-color 180ms ease;
  }

  :global(.reaction-button::before) {
    position: absolute;
    inset: 0;
    z-index: -1;
    background: linear-gradient(115deg, transparent 20%, rgb(255 255 255 / 0.2) 46%, transparent 72%);
    content: '';
    transform: translateX(-115%);
    transition: transform 550ms ease;
  }

  :global(.reaction-button:hover:not(:disabled)) {
    transform: translateY(-4px);
  }

  :global(.reaction-button:hover:not(:disabled)::before) {
    transform: translateX(115%);
  }

  :global(.love-button:hover:not(:disabled) .love-heart) {
    animation: heart-jiggle 680ms var(--ease-spring) both;
  }

  :global(.maybe-button:hover:not(:disabled) .maybe-face) {
    animation: face-consider 900ms ease-in-out infinite alternate;
  }

  .maybe-dots i {
    width: 0.28rem;
    height: 0.28rem;
    border-radius: 999px;
    background: currentcolor;
    opacity: 0;
    transform: translateY(0.35rem) scale(0);
  }

  :global(.maybe-button:hover:not(:disabled) .maybe-dots i) {
    animation: dot-pop 720ms var(--ease-spring) infinite alternate;
  }

  :global(.maybe-button:hover:not(:disabled) .maybe-dots i:nth-child(2)) {
    animation-delay: 110ms;
  }

  :global(.maybe-button:hover:not(:disabled) .maybe-dots i:nth-child(3)) {
    animation-delay: 220ms;
  }

  :global(.pass-button:hover:not(:disabled) .pass-thumb) {
    animation: thumb-bounce-down 720ms var(--ease-spring) both;
  }

  @keyframes heart-jiggle {
    0%,
    100% { transform: rotate(0) scale(1); }
    18% { transform: rotate(-13deg) scale(1.09); }
    36% { transform: rotate(11deg) scale(1.12); }
    54% { transform: rotate(-8deg) scale(1.08); }
    72% { transform: rotate(5deg) scale(1.04); }
  }

  @keyframes face-consider {
    from { transform: rotate(-4deg) translateY(0); }
    to { transform: rotate(4deg) translateY(-2px); }
  }

  @keyframes dot-pop {
    0%,
    20% {
      opacity: 0;
      transform: translateY(0.35rem) scale(0);
    }
    75%,
    100% {
      opacity: 0.95;
      transform: translateY(0) scale(1);
    }
  }

  @keyframes thumb-bounce-down {
    0%,
    100% { transform: translateY(0) rotate(0); }
    30% { transform: translateY(10px) rotate(8deg); }
    52% { transform: translateY(4px) rotate(3deg); }
    72% { transform: translateY(8px) rotate(6deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.reaction-button:hover:not(:disabled) .love-heart),
    :global(.maybe-button:hover:not(:disabled) .maybe-face),
    :global(.maybe-button:hover:not(:disabled) .maybe-dots i),
    :global(.pass-button:hover:not(:disabled) .pass-thumb) {
      animation: none;
    }
  }
</style>
