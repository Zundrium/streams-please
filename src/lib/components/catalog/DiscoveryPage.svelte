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
    RefreshCw,
    Sparkles,
    ThumbsDown
  } from '@lucide/svelte';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import { Switch } from '$lib/components/ui/switch';
  import { Tabs, TabsList, TabsTrigger } from '$lib/components/ui/tabs';
  import AnimatedProgress from '$lib/components/shared/AnimatedProgress.svelte';
  import CatalogLoading from '$lib/components/catalog/CatalogLoading.svelte';
  import CatalogNotice from '$lib/components/catalog/CatalogNotice.svelte';
  import SeasonNavigator from '$lib/components/catalog/SeasonNavigator.svelte';
  import ContextToolbar from '$lib/components/shared/ContextToolbar.svelte';
  import RevealFrame from '$lib/components/shared/RevealFrame.svelte';
  import RevealImage from '$lib/components/shared/RevealImage.svelte';
  import { isTauri } from '$lib/backend';
  import {
    currentSeason,
    decodeEntities,
    errorMessage,
    loadProviderMappings,
    metadataLabel,
    posterUrl,
    saveProviderMapping,
    seasonLabel,
    seasonOrdinal,
    shiftSeason
  } from '$lib/catalog';
  import { trailerLinks } from '$lib/catalog/media';
  import { createSeasonCatalog } from '$lib/catalog/season.svelte';
  import {
    catalogSourceLabel,
    type CatalogProvenance,
    type CatalogSearchResponse
  } from '$lib/catalog/providers';
  import CatalogStatusBadge from '$lib/components/catalog/CatalogStatusBadge.svelte';
  import {
    candidateKey,
    candidateTiming,
    toAiringCandidate,
    toRecommendationCandidate,
    type DiscoveryCandidate,
    type DiscoveryMode
  } from '$lib/discovery/airing';
  import { createRecommendationDiscovery } from '$lib/discovery/recommendations.svelte';
  import {
    filterReviewedRecommendations,
    matchAvailableRecommendations,
    mergeRecommendationDetails
  } from '$lib/discovery/recommendations';
  import { libraryEntryMatches } from '$lib/library';
  import { youtubeTrailerSearchPlaybackUrl } from '$lib/trailers';
  import {
    type AnimeSeason,
    type AniListSeasonResponse,
    type AniListSeasonShow,
    type CatalogMedia,
    type DayName,
    type DiscoveryVerdict,
    type LibraryEntry,
    type SubsPleaseIndexResponse,
    type SubsPleaseScheduleResponse,
    type SubsPleaseScheduleShow,
    type SubsPleaseShowResponse,
    type TrailerPlaybackRequest
  } from '$lib/types';
  import { localTimezone } from '$lib/time';

  const TEXT_REVEAL_DURATION_MS = 360;

  let {
    loadSeason,
    loadRecommendations,
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
    loadRecommendations: (ids: number[]) => Promise<CatalogSearchResponse>;
    loadIndex: () => Promise<SubsPleaseIndexResponse>;
    loadSchedule: (timezone: string) => Promise<SubsPleaseScheduleResponse>;
    loadShow: (
      slug: string,
      timezone: string,
      anilistId?: number,
      includeMetadata?: boolean
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

  const timezone = localTimezone();
  const initialSeason = currentSeason();
  const furthestSeason = shiftSeason(initialSeason.season, initialSeason.year, 1);

  const seasonCatalog = createSeasonCatalog({
    loadSeason: (season, year) => loadSeason(season, year),
    loadIndex: () => loadIndex(),
    loadSchedule: (requestedTimezone) => loadSchedule(requestedTimezone),
    timezone,
    initialSeason
  });
  const recommendationDiscovery = createRecommendationDiscovery((ids) =>
    loadRecommendations(ids)
  );

  let selectedSeason = $derived(seasonCatalog.season);
  let selectedYear = $derived(seasonCatalog.year);
  let discoveryMode = $state<DiscoveryMode>('airing');
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
  let trailerLifecycleGeneration = 0;

  let selectedIsCurrentSeason = $derived(
    selectedSeason === initialSeason.season && selectedYear === initialSeason.year
  );
  let canMoveNext = $derived(
    seasonOrdinal(selectedSeason, selectedYear) <
      seasonOrdinal(furthestSeason.season, furthestSeason.year)
  );
  let allAiringCandidates = $derived.by((): DiscoveryCandidate[] =>
    seasonCatalog.seasonMatches.flatMap((match) => {
      const candidate = toAiringCandidate(match, selectedSeason, selectedYear);
      return candidate ? [candidate] : [];
    })
  );
  let eligibleAiringCandidates = $derived(
    allAiringCandidates.filter(({ show }) => !metadataSequelSlugs.includes(show.page))
  );
  let airingCandidates = $derived.by(() => {
    const checked = libraryEntries.filter((entry) => entry.discoveryVerdict);
    return eligibleAiringCandidates.filter(
      ({ anime, show }) =>
        !checked.some((entry) => libraryEntryMatches(entry, anime.id, show.page))
    );
  });
  let availableRecommendationMatches = $derived.by(() =>
    matchAvailableRecommendations(
      recommendationDiscovery.catalog?.results ?? [],
      seasonCatalog.providerIndex?.shows ?? [],
      loadProviderMappings()
    )
  );
  let recommendationMatches = $derived.by(() =>
    filterReviewedRecommendations(availableRecommendationMatches, libraryEntries)
  );
  let eligibleRecommendationCandidates = $derived(
    availableRecommendationMatches.map(toRecommendationCandidate)
  );
  let recommendationCandidates = $derived(recommendationMatches.map(toRecommendationCandidate));
  let eligibleCandidates = $derived(
    discoveryMode === 'airing' ? eligibleAiringCandidates : eligibleRecommendationCandidates
  );
  let candidates = $derived(
    discoveryMode === 'airing' ? airingCandidates : recommendationCandidates
  );
  let recommendationRequestReady = $derived(recommendationDiscovery.seedIds.length > 0);
  let discoveryLoading = $derived(
    discoveryMode === 'airing'
      ? seasonCatalog.catalogLoading || seasonCatalog.providerLoading
      : recommendationRequestReady &&
        (recommendationDiscovery.loading || seasonCatalog.providerLoading)
  );
  let discoveryError = $derived(
    discoveryMode === 'airing'
      ? seasonCatalog.catalogError || seasonCatalog.providerError
      : recommendationRequestReady
        ? recommendationDiscovery.error || seasonCatalog.providerError
        : ''
  );
  let activeProvenance = $derived<CatalogProvenance | undefined>(
    discoveryMode === 'airing'
      ? seasonCatalog.catalog?.provenance
      : recommendationDiscovery.catalog?.provenance
  );
  let activeCacheWarning = $derived(
    discoveryMode === 'airing'
      ? seasonCatalog.catalog?.cacheWarning
      : recommendationDiscovery.catalog?.cacheWarning
  );
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
  let trailerPlayback = $derived(
    trailerLinks(details?.trailer, typeof window === 'undefined' ? '' : window.location.origin)
  );
  let baseEmbedUrl = $derived(trailerPlayback.embedUrl);
  let embedUrl = $derived(
    baseEmbedUrl && autoplayedCandidateKey === presentedCandidateKey
      ? `${baseEmbedUrl}${baseEmbedUrl.includes('?') ? '&' : '?'}autoplay=1&mute=1`
      : baseEmbedUrl
  );
  let trailerUrl = $derived.by(() => {
    if (!details) return '';
    if (isTauri()) return youtubeTrailerSearchPlaybackUrl(details.title);
    return trailerPlayback.watchUrl;
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
      trailerLifecycleGeneration += 1;
      seasonCatalog.dispose();
      recommendationDiscovery.dispose();
      window.removeEventListener('keydown', onKeyDown);
    };
  });

  $effect(() => {
    const page = discoveryPageElement;
    discoveryMode;
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
        if (candidate.mode === 'airing' && nextDetails.has_series_prequel) {
          excludeMetadataSequel(candidate.show.page);
          return;
        }
        presentedCandidate = candidate;
        details = nextDetails;
        loadedCandidateKey = key;
      })
      .catch((reason) => {
        if (!cancelled && currentCandidateKey === key) {
          detailsError = errorMessage(reason);
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
    const generation = trailerLifecycleGeneration;
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
        if (generation === trailerLifecycleGeneration && presentedCandidateKey === key) {
          autoplayedCandidateKey = key;
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (generation === trailerLifecycleGeneration && autoplayingCandidateKey === key) {
          autoplayingCandidateKey = '';
        }
      });
  });

  async function requestCandidateDetails(
    candidate: DiscoveryCandidate
  ): Promise<SubsPleaseShowResponse> {
    const nextDetails = await loadShow(
      candidate.show.page,
      timezone,
      candidate.anime.id,
      candidate.mode === 'airing'
    );
    return candidate.mode === 'recommendations'
      ? mergeRecommendationDetails(
          nextDetails,
          candidate.anime,
          recommendationDiscovery.catalog?.provenance?.label
        )
      : nextDetails;
  }

  function selectDiscoveryMode(value: string): void {
    if (value !== 'airing' && value !== 'recommendations') return;
    if (value === discoveryMode) return;
    trailerLifecycleGeneration += 1;
    trailerTheaterMode = false;
    autoplayedCandidateKey = '';
    autoplayingCandidateKey = '';
    discoveryMode = value;
    if (value === 'recommendations') {
      void recommendationDiscovery.enter(libraryEntries);
    } else {
      recommendationDiscovery.leave();
    }
    void onCloseTrailer();
  }

  function refreshRecommendations(): void {
    if (discoveryMode !== 'recommendations') return;
    trailerLifecycleGeneration += 1;
    autoplayedCandidateKey = '';
    autoplayingCandidateKey = '';
    void onCloseTrailer();
    void recommendationDiscovery.refresh(libraryEntries);
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

</script>

<main
  bind:this={discoveryPageElement}
  class="h-full min-h-0 overflow-x-clip overflow-y-auto text-(--text)"
  style="overflow-anchor: none"
  data-content-state={discoveryError || visibleDetailsError ? 'error' : discoveryLoading || (currentCandidate && !detailsReady) ? 'loading' : mediaRevealReady ? 'media-enabled' : 'text-ready'}
  aria-label="Discover anime"
>
  <ContextToolbar class="grid h-auto min-h-16 grid-cols-[minmax(0,1fr)_auto] gap-3 py-3 md:h-16 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:gap-8 md:py-0">
    <div class="col-start-1 row-start-2 flex min-w-0 w-full max-w-sm items-center gap-2 justify-self-start md:row-start-1">
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
      {#if discoveryMode === 'recommendations' && recommendationRequestReady}
        <Button
          variant="ghost"
          size="icon"
          class="size-9 shrink-0"
          disabled={recommendationDiscovery.loading}
          aria-label="Refresh recommendations"
          onclick={refreshRecommendations}
        >
          <RefreshCw class="size-4 {recommendationDiscovery.loading ? 'animate-spin' : ''}" />
        </Button>
      {/if}
    </div>

    {#if discoveryMode === 'airing'}
      <div class="col-start-2 row-start-2 justify-self-end md:row-start-1 md:justify-self-center">
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
      </div>
    {:else}
      <p class="col-start-2 row-start-1 hidden text-center text-xs font-medium text-(--text)/42 md:block">
        Based on your recent loves
      </p>
    {/if}

    <Tabs
      value={discoveryMode}
      onValueChange={selectDiscoveryMode}
      class="col-span-2 col-start-1 row-start-1 gap-0 justify-self-end md:col-span-1 md:col-start-3"
    >
      <TabsList aria-label="Discovery mode" class="gap-0.5 p-0.5">
        <TabsTrigger value="airing" class="px-3 py-1.5">Airing</TabsTrigger>
        <TabsTrigger value="recommendations" class="px-3 py-1.5">Recommendations</TabsTrigger>
      </TabsList>
    </Tabs>
  </ContextToolbar>

  <div class="relative mx-auto flex min-h-[calc(100%_-_4rem)] max-w-[100rem] flex-col px-5 py-7 lg:px-10 lg:py-8">
    {#if seasonCatalog.providerIndex?.cacheWarning}
      <CatalogNotice kind="warning" title="Saved archive" description={seasonCatalog.providerIndex.cacheWarning} class="mb-6" />
    {/if}
    {#if discoveryMode === 'airing' && seasonCatalog.scheduleError}
      <CatalogNotice
        kind="warning"
        class="mb-6"
        title="Schedule times unavailable"
        description={seasonCatalog.scheduleError}
        actionLabel="Retry schedule"
        onAction={() => void seasonCatalog.refreshSchedule()}
      />
    {/if}

    {#if discoveryError}
      <section class="grid min-h-[60vh] place-items-center">
        <div class="w-full max-w-xl space-y-4">
          {#if discoveryMode === 'airing' && seasonCatalog.catalogError}
            <CatalogNotice
              kind="error"
              title="Season catalog unavailable"
              description={seasonCatalog.catalogError}
              actionLabel="Retry catalog"
              onAction={() => void seasonCatalog.refreshSeason()}
            />
          {:else if discoveryMode === 'recommendations' && recommendationDiscovery.error}
            <CatalogNotice
              kind="error"
              title="Recommendations unavailable"
              description={recommendationDiscovery.error}
              actionLabel="Try again"
              onAction={refreshRecommendations}
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
        label={discoveryMode === 'airing'
          ? `Finding shows for ${seasonLabel(selectedSeason)} ${selectedYear}`
          : 'Finding recommendations you can watch'}
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
          {#if discoveryMode === 'recommendations' && !recommendationRequestReady}
            <span class="mx-auto grid size-16 place-items-center rounded-full bg-pink-500/10 text-pink-500"><Heart class="size-8" /></span>
            <h2 class="mt-5 text-2xl font-semibold tracking-[-0.045em]">Love a show to get recommendations</h2>
            <p class="mt-2 text-sm leading-6 text-(--text)/45">Recommendations use canonical AniList IDs from up to ten of your most recently loved shows.</p>
            <Button class="mt-6 gap-2" onclick={() => selectDiscoveryMode('airing')}><Sparkles class="size-4" /> Browse airing shows</Button>
          {:else if eligibleCandidates.length}
            <span class="mx-auto grid size-16 place-items-center rounded-full bg-chart-2/12 text-chart-2"><CheckCircle2 class="size-8" /></span>
            <h2 class="mt-5 text-2xl font-semibold tracking-[-0.045em]">
              {discoveryMode === 'airing'
                ? `You checked every new show in ${seasonLabel(selectedSeason)} ${selectedYear}`
                : 'You checked every playable recommendation'}
            </h2>
            <p class="mt-2 text-sm leading-6 text-(--text)/45">
              {discoveryMode === 'airing'
                ? 'Your choices are saved in the library. You can revisit another season or review the shows you kept.'
                : 'Your choices are saved in the library. Refresh when you want a new snapshot based on your latest loves.'}
            </p>
            <div class="mt-6 flex flex-wrap justify-center gap-2">
              <Button class="gap-2" onclick={onOpenLibrary}><Check class="size-4" /> View checked shows</Button>
              {#if discoveryMode === 'recommendations'}
                <Button variant="ghost" class="gap-2" onclick={refreshRecommendations}><RefreshCw class="size-4" /> Refresh</Button>
              {/if}
            </div>
          {:else if discoveryMode === 'recommendations'}
            <span class="mx-auto grid size-16 place-items-center rounded-full bg-(--text)/6 text-(--text)/35"><Sparkles class="size-8" /></span>
            <h2 class="mt-5 text-2xl font-semibold tracking-[-0.045em]">No playable recommendations yet</h2>
            <p class="mt-2 text-sm leading-6 text-(--text)/45">
              {recommendationDiscovery.catalog?.results.length
                ? 'Recommendations were found, but none could be confidently matched to the SubsPlease archive. Only confirmed matches are shown for playback.'
                : 'No recommendations were found from this snapshot. Only titles with a confirmed SubsPlease archive match can appear here.'}
            </p>
            <Button variant="ghost" class="mt-6 gap-2" onclick={refreshRecommendations}><RefreshCw class="size-4" /> Refresh recommendations</Button>
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
              <div class="min-w-0 flex-1 pt-0.5">
                <div class="flex items-start gap-4">
                  <h2 id={titleId} class="min-w-0 flex-1 text-3xl font-semibold leading-[1.02] tracking-[-0.055em] lg:text-4xl">{decodeEntities(details.title)}</h2>
                  <label class="flex shrink-0 items-center gap-2.5 pt-1 text-sm font-medium text-(--text)/70">
                    <span class="hidden sm:inline">Autoplay</span>
                    <Switch
                      class="focus-visible:ring-2 focus-visible:ring-(--text)/24"
                      checked={autoplay}
                      aria-label="Autoplay trailers"
                      onCheckedChange={(checked) => (autoplay = checked)}
                    />
                  </label>
                </div>
                <div class="mt-3 flex flex-wrap gap-2" aria-label="Show tags and details">
                  {#each details.genres?.slice(0, 4) ?? [] as genre (genre)}
                    <Badge class="bg-blue-500/12 text-blue-600 ring-1 ring-inset ring-blue-500/15 dark:text-blue-300">{genre}</Badge>
                  {/each}
                  {#if details.year}<Badge class="bg-(--text)/6 text-(--text)/58">{details.year}</Badge>{/if}
                  {#if details.format}<Badge class="bg-(--text)/6 text-(--text)/58">{metadataLabel(details.format)}</Badge>{/if}
                  {#if details.status}<Badge class="bg-(--text)/6 text-(--text)/58">{metadataLabel(details.status)}</Badge>{/if}
                  <Badge class="bg-(--text)/6 text-(--text)/58"><Clock3 class="size-3" /> {candidateTiming(presentedCandidate)}</Badge>
                  {#if activeProvenance}
                    <Badge
                      class="bg-(--text)/6 text-(--text)/58"
                      title={[catalogSourceLabel(activeProvenance), activeCacheWarning].filter(Boolean).join(' · ')}
                    >
                      {catalogSourceLabel(activeProvenance)}
                    </Badge>
                    <CatalogStatusBadge provenance={activeProvenance} warning={activeCacheWarning} />
                  {/if}
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
