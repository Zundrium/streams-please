<script lang="ts">
  import {
    ArrowLeft,
    ArrowRight,
    BookMarked,
    BookmarkPlus,
    CalendarDays,
    CheckCircle2,
    CircleHelp,
    Clock3,
    ExternalLink,
    Film,
    Heart,
    Meh,
    Play,
    Search,
    Star,
    ThumbsDown,
    Tv2,
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
  import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger
  } from '$lib/components/ui/select';
  import { Separator } from '$lib/components/ui/separator';
  import { Spinner } from '$lib/components/ui/spinner';
  import { Switch } from '$lib/components/ui/switch';
  import RevealImage from '$lib/components/shared/RevealImage.svelte';
  import ContextToolbar from '$lib/components/shared/ContextToolbar.svelte';
  import TasteIndicator from '$lib/components/catalog/TasteIndicator.svelte';
  import { isTauri } from '$lib/backend';
  import { decodeEntities, errorMessage, metadataLabel, posterUrl, preferredTitle } from '$lib/catalog';
  import { preferredDownload, trailerLinks } from '$lib/catalog/media';
  import { buildEpisodeSupplements, episodeNumberKey } from '$lib/episodeMetadata';
  import {
    youtubeTrailerSearchPageUrl,
    youtubeTrailerSearchPlaybackUrl
  } from '$lib/trailers';
  import type {
    AniListDate,
    AniListRelationNode,
    DayName,
    DiscoveryVerdict,
    EpisodePlaybackRequest,
    LibraryEntry,
    PlaybackQuality,
    SubsPleaseDownload,
    SubsPleaseRelease,
    SubsPleaseScheduleShow,
    SubsPleaseShowResponse,
    TrailerPlaybackRequest
  } from '$lib/types';
  import { localTimezone } from '$lib/time';

  const TEXT_REVEAL_DURATION_MS = 360;
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
    show,
    day,
    libraryEntry,
    discoveryVerdict,
    loadShow,
    onBack,
    onPlay,
    onPlayTrailer,
    onToggleLibrary,
    onSetDiscoveryVerdict,
    onToggleWatched,
    onShowLoaded,
    onOpenRelation,
    preferredQuality
  }: {
    show: SubsPleaseScheduleShow;
    day?: DayName;
    libraryEntry?: LibraryEntry;
    discoveryVerdict?: DiscoveryVerdict;
    loadShow: (
      slug: string,
      timezone: string,
      anilistId?: number
    ) => Promise<SubsPleaseShowResponse>;
    onBack: () => void | Promise<void>;
    onPlay: (request: EpisodePlaybackRequest) => Promise<void>;
    onPlayTrailer: (request: TrailerPlaybackRequest) => void | Promise<void>;
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
    onOpenRelation: (media: AniListRelationNode) => Promise<void>;
    preferredQuality: PlaybackQuality;
  } = $props();

  const timezone = localTimezone();
  const calendarDayFormatter = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: timezone
  });
  const todayCalendarDay = calendarDayFormatter.format(new Date());
  let details = $state<SubsPleaseShowResponse | null>(null);
  let loadedShowPage = $state('');
  let mediaRevealShowPage = $state('');
  let detailsLoading = $state(true);
  let detailsError = $state('');
  let detailsRetry = $state(0);
  let episodeQuery = $state('');
  let episodeLimit = $state(18);
  let playingKey = $state('');
  let trailerError = $state('');
  let relationNavigationId = $state<number | null>(null);
  let relationError = $state('');
  let detailsReady = $derived(
    !detailsLoading && loadedShowPage === show.page && details !== null
  );
  let mediaRevealReady = $derived(
    detailsReady && mediaRevealShowPage === show.page
  );
  let episodeSupplements = $derived(buildEpisodeSupplements(details));
  let prominentTags = $derived.by(() =>
    [...(details?.tags ?? [])]
      .filter((tag) => !tag.isGeneralSpoiler && !tag.isMediaSpoiler)
      .sort((left, right) => (right.rank ?? 0) - (left.rank ?? 0))
      .slice(0, 6)
  );
  let primaryStudios = $derived.by(() =>
    (details?.studios?.nodes ?? [])
      .filter((studio) => studio.isAnimationStudio !== false)
      .map((studio) => studio.name)
      .slice(0, 2)
  );

  let episodes = $derived.by(() => {
    const all = Object.values(details?.episode ?? {});
    const term = episodeQuery.trim().toLowerCase();
    return (term
      ? all.filter((release) => {
          const supplement = episodeSupplements.get(episodeNumberKey(release.episode));
          return `${release.show} ${release.episode} ${supplement?.title ?? ''}`
            .toLowerCase()
            .includes(term);
        })
      : all
    ).sort((left, right) => {
      const leftEpisode = Number.parseFloat(left.episode);
      const rightEpisode = Number.parseFloat(right.episode);
      if (Number.isFinite(leftEpisode) && Number.isFinite(rightEpisode)) return rightEpisode - leftEpisode;
      return new Date(right.release_date).getTime() - new Date(left.release_date).getTime();
    });
  });
  let exactTrailerUrl = $derived(trailerLinks(details?.trailer).watchUrl);
  let trailerTargetUrl = $derived(
    exactTrailerUrl || youtubeTrailerSearchPageUrl(details?.title || show.title)
  );
  let prequelRelations = $derived.by(() =>
    (details?.relations?.edges ?? []).flatMap((edge) =>
      edge.relationType === 'PREQUEL' && edge.node?.type === 'ANIME'
        ? [edge.node]
        : []
    )
  );
  let sequelRelations = $derived.by(() =>
    (details?.relations?.edges ?? []).flatMap((edge) =>
      edge.relationType === 'SEQUEL' && edge.node?.type === 'ANIME'
        ? [edge.node]
        : []
    )
  );

  $effect(() => {
    const activeShow = show;
    const activeDay = day;
    detailsRetry;
    let cancelled = false;
    details = null;
    loadedShowPage = '';
    detailsLoading = true;
    detailsError = '';
    episodeQuery = '';
    episodeLimit = 18;
    trailerError = '';
    relationNavigationId = null;
    relationError = '';
    loadShow(activeShow.page, timezone, activeShow.anilist_id)
      .then((nextDetails) => {
        if (cancelled) return;
        details = nextDetails;
        loadedShowPage = activeShow.page;
        onShowLoaded(nextDetails, activeShow, activeDay);
      })
      .catch((reason) => {
        if (!cancelled) detailsError = errorMessage(reason);
      })
      .finally(() => {
        if (!cancelled) detailsLoading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    const activePage = show.page;
    if (!detailsReady) {
      mediaRevealShowPage = '';
      return;
    }

    const timer = window.setTimeout(() => {
      if (show.page === activePage && loadedShowPage === activePage) {
        mediaRevealShowPage = activePage;
      }
    }, TEXT_REVEAL_DURATION_MS);

    return () => window.clearTimeout(timer);
  });

  function releaseDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('en-US', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    }).format(date);
  }

  function airingDate(value: number): string {
    const date = new Date(value * 1000);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone
    }).format(date);
  }

  function animeDate(value?: AniListDate): string {
    if (!value?.year) return '';
    if (!value.month) return String(value.year);
    const date = new Date(Date.UTC(value.year, value.month - 1, value.day ?? 1));
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      ...(value.day ? { day: 'numeric' as const } : {}),
      year: 'numeric',
      timeZone: 'UTC'
    }).format(date);
  }

  function originalRun(): string {
    const start = animeDate(details?.start_date);
    const end = animeDate(details?.end_date);
    if (!start) return end;
    return `${start} – ${end || (details?.status === 'RELEASING' ? 'present' : 'TBA')}`;
  }

  function seasonLabel(): string {
    if (!details?.season) return details?.year ? String(details.year) : '';
    return `${metadataLabel(details.season)}${details.year ? ` ${details.year}` : ''}`;
  }

  function countryLabel(value: string): string {
    try {
      return new Intl.DisplayNames(['en'], { type: 'region' }).of(value) ?? value;
    } catch {
      return value;
    }
  }

  function popularityLabel(value: number): string {
    return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
      value
    );
  }

  function qualityLabel(release: SubsPleaseRelease): string {
    return [...new Set(release.downloads.map((download) => download.res))]
      .sort((left, right) => Number(left) - Number(right))
      .map((quality) => `${quality}p`)
      .join(' · ');
  }

  function nextAiringLabel(): string {
    const airing = details?.next_airing_episode;
    if (!airing?.airingAt) return '';
    return `Episode ${airing.episode} airs ${airingDate(airing.airingAt)}`;
  }

  function wasReleasedToday(value: string): boolean {
    const date = new Date(value);
    return !Number.isNaN(date.getTime()) && calendarDayFormatter.format(date) === todayCalendarDay;
  }

  async function openRelatedShow(media: AniListRelationNode): Promise<void> {
    relationNavigationId = media.id;
    relationError = '';
    try {
      await onOpenRelation(media);
    } catch (reason) {
      relationError = errorMessage(reason);
    } finally {
      relationNavigationId = null;
    }
  }

  function isWatched(episode: string): boolean {
    return libraryEntry?.watchedEpisodes.includes(episode) ?? false;
  }

  function setDiscoveryVerdict(value: unknown) {
    if (!details) return;
    const verdict = String(value);
    onSetDiscoveryVerdict(
      details,
      show,
      day,
      verdict === 'love' || verdict === 'maybe' || verdict === 'pass' ? verdict : undefined
    );
  }

  async function openTrailer() {
    if (!details) return;
    trailerError = '';
    try {
      if (isTauri()) {
        await onPlayTrailer({
          url: youtubeTrailerSearchPlaybackUrl(details.title || show.title),
          title: `${decodeEntities(details.title || show.title)} · Trailer`,
          thumbnail:
            details.trailer?.thumbnail ||
            details.banner_image_url ||
            posterUrl(details.image_url) ||
            undefined
        });
      } else {
        const opened = window.open(trailerTargetUrl, '_blank', 'noopener,noreferrer');
        if (!opened) throw new Error('The browser blocked the new window.');
      }
    } catch (reason) {
      trailerError = errorMessage(reason);
    }
  }

  async function playRelease(
    key: string,
    release: SubsPleaseRelease,
    download?: SubsPleaseDownload
  ) {
    if (!download) return;
    playingKey = key;
    try {
      await onPlay({
        anilistId: details?.metadata_id ?? show.anilist_id,
        slug: details?.slug || show.page,
        title: details?.title || show.title,
        imageUrl: details?.image_url || show.image_url,
        episode: release.episode,
        magnet: download.magnet,
        quality: download.res,
        day,
        airingTime: show.time
      });
    } finally {
      playingKey = '';
    }
  }
</script>

<section
  class="h-full min-h-0 overflow-y-auto bg-(--bg) text-(--text)"
  data-content-state={detailsReady ? mediaRevealReady ? 'media-enabled' : 'text-ready' : detailsError ? 'error' : 'loading'}
  aria-label={`${show.title} details`}
>
  <ContextToolbar overlay class="justify-start">
    <Button variant="ghost" size="sm" class="gap-2 bg-(--bg-elevated)/60" onclick={() => void onBack()}>
      <ArrowLeft class="size-4" /> Back
    </Button>
    {#if detailsReady && details}
      <Separator orientation="vertical" class="h-6" />
      <p class="text-reveal min-w-0 truncate text-sm font-medium text-(--text)/60">{decodeEntities(details.title)}</p>
    {/if}
  </ContextToolbar>

  {#if detailsLoading || (!detailsReady && !detailsError)}
    <div class="h-full min-h-[42rem] bg-(--bg)" aria-busy="true" role="status">
      <span class="sr-only">Loading show details</span>
    </div>
  {:else if detailsError}
    <div class="grid h-full min-h-[42rem] place-items-center bg-(--bg) px-5 pt-16">
      <Alert variant="destructive" class="max-w-xl">
        <Tv2 class="size-5" />
        <AlertTitle>Show unavailable</AlertTitle>
        <AlertDescription>{detailsError}</AlertDescription>
        <Button variant="ghost" size="sm" class="mt-4" onclick={() => (detailsRetry += 1)}>Try again</Button>
      </Alert>
    </div>
  {:else if detailsReady && details}
  <section class="media-placeholder relative isolate min-h-[42rem] overflow-hidden lg:min-h-[52rem]" aria-label="Show introduction">
    {#if details.banner_image_url || details.image_url}
      <RevealImage
        class="absolute inset-0 -z-30 size-full scale-105 object-cover object-[center_28%] opacity-70 blur-[2px]"
        src={posterUrl(details.banner_image_url || details.image_url)}
        alt=""
        loading="eager"
        fetchpriority="high"
        reveal={mediaRevealReady}
      />
    {/if}
    <div class="absolute inset-0 -z-20 bg-gradient-to-r from-(--bg)/85 via-(--bg)/38 to-(--bg)/15"></div>
    <div
      class="absolute inset-0 -z-10"
      style="background: linear-gradient(to bottom, rgba(0, 0, 0, 0.14) 0%, transparent 38%, color-mix(in srgb, var(--bg) 22%, transparent) 62%, color-mix(in srgb, var(--bg) 72%, transparent) 80%, var(--bg) 96%);"
    ></div>

    <div class="mx-auto flex min-h-[42rem] max-w-7xl items-end px-6 pb-40 pt-36 lg:min-h-[52rem] lg:px-12 lg:pb-64">
      <div class="grid w-full items-end gap-7 md:grid-cols-[11rem_minmax(0,1fr)] lg:grid-cols-[13rem_minmax(0,1fr)]">
        <div class="media-placeholder relative hidden aspect-[3/4] overflow-hidden rounded-lg border border-white/15 shadow-2xl shadow-black/35 md:block">
          {#if details.image_url}
            <RevealImage class="size-full object-cover" src={posterUrl(details.image_url)} alt="" loading="eager" fetchpriority="high" reveal={mediaRevealReady} />
          {:else}
            <span class="grid size-full place-items-center"><Film class="size-10 text-(--text)/25" /></span>
          {/if}
          <TasteIndicator verdict={discoveryVerdict} class="absolute bottom-3 right-3" />
        </div>
        <div class="pb-2 drop-shadow-sm">
          {#if prequelRelations.length || sequelRelations.length}
            <div class="text-reveal mb-3 flex flex-wrap items-center gap-2" aria-label="Series order">
              {#each prequelRelations as media (media.id)}
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-8 gap-1.5 rounded-full border-white/12 bg-black/18 px-3 text-xs text-white/68 backdrop-blur hover:bg-white/10 hover:text-white"
                  disabled={relationNavigationId !== null}
                  aria-label={`Open prequel ${preferredTitle(media)}`}
                  title={preferredTitle(media)}
                  onclick={() => void openRelatedShow(media)}
                >
                  {#if relationNavigationId === media.id}
                    <Spinner class="size-3.5" />
                  {:else}
                    <ArrowLeft class="size-3.5 opacity-65" />
                  {/if}
                  Prequel
                </Button>
              {/each}
              {#each sequelRelations as media (media.id)}
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-8 gap-1.5 rounded-full border-white/12 bg-black/18 px-3 text-xs text-white/68 backdrop-blur hover:bg-white/10 hover:text-white"
                  disabled={relationNavigationId !== null}
                  aria-label={`Open sequel ${preferredTitle(media)}`}
                  title={preferredTitle(media)}
                  onclick={() => void openRelatedShow(media)}
                >
                  Sequel
                  {#if relationNavigationId === media.id}
                    <Spinner class="size-3.5" />
                  {:else}
                    <ArrowRight class="size-3.5 opacity-65" />
                  {/if}
                </Button>
              {/each}
            </div>
          {/if}
          {#if relationError}
            <p class="text-reveal mb-3 text-sm text-red-400" role="alert">{relationError}</p>
          {/if}
          <h1 class:text-reveal={Boolean(details)} class="max-w-4xl text-4xl font-semibold leading-[0.98] tracking-[-0.06em] sm:text-5xl lg:text-7xl">
            {decodeEntities(details.title)}
          </h1>
          <div class:text-reveal={Boolean(details)} class="mt-5 flex flex-wrap gap-2" aria-label="Show tags and details">
            {#each details?.genres?.slice(0, 4) ?? [] as genre (genre)}
              <Badge class="bg-blue-500/22 text-blue-100 ring-1 ring-inset ring-blue-300/20 backdrop-blur">{genre}</Badge>
            {/each}
            {#if day}
              <Badge class="bg-(--bg-elevated)/75 text-(--text)/70 backdrop-blur"><CalendarDays class="size-3" /> {DAY_LABELS[day]} · {show.time}</Badge>
            {:else if libraryEntry}
              <Badge class="bg-(--bg-elevated)/75 text-(--text)/70 backdrop-blur"><BookMarked class="size-3" /> In your library</Badge>
            {:else}
              <Badge class="bg-(--bg-elevated)/75 text-(--text)/70 backdrop-blur"><BookMarked class="size-3" /> SubsPlease archive</Badge>
            {/if}
            {#if details?.year}<Badge class="bg-(--bg-elevated)/75 text-(--text)/70 backdrop-blur">{details.year}</Badge>{/if}
            {#if details?.format}<Badge class="bg-(--bg-elevated)/75 text-(--text)/70 backdrop-blur">{metadataLabel(details.format)}</Badge>{/if}
            {#if details?.status}<Badge class="bg-(--bg-elevated)/75 text-(--text)/70 backdrop-blur">{metadataLabel(details.status)}</Badge>{/if}
            {#if details?.episode_count}<Badge class="bg-(--bg-elevated)/75 text-(--text)/70 backdrop-blur">{details.episode_count} episodes</Badge>{/if}
            {#if details?.duration}<Badge class="bg-(--bg-elevated)/75 text-(--text)/70 backdrop-blur"><Clock3 class="size-3" /> {details.duration} min</Badge>{/if}
            {#if details?.average_score}<Badge class="bg-(--bg-elevated)/75 text-(--text)/70 backdrop-blur"><Star class="size-3" fill="currentColor" /> {details.average_score}%</Badge>{/if}
          </div>
          <div class="mt-7 flex flex-wrap gap-2">
            <Button size="lg" class="gap-2" disabled={detailsLoading} onclick={() => void openTrailer()}>
              {#if detailsLoading}<Spinner class="size-4 border-(--bg)/20 border-t-(--bg)" />{:else}<Play class="size-4" fill="currentColor" />{/if}
              Watch trailer <ExternalLink class="size-3.5 opacity-55" />
            </Button>
            <Select
              type="single"
              value={discoveryVerdict ?? 'unknown'}
              onValueChange={setDiscoveryVerdict}
            >
              <SelectTrigger
                class="h-11 min-w-36 rounded-3xl bg-(--bg-elevated)/72 backdrop-blur"
                disabled={!details}
                aria-label="Taste status"
                title={`Taste: ${discoveryVerdict === 'love' ? 'Love' : discoveryVerdict === 'maybe' ? 'OK' : discoveryVerdict === 'pass' ? 'Not for me' : 'Unknown'}`}
              >
                {#if discoveryVerdict === 'love'}
                  <Heart class="size-4 text-chart-5" fill="currentColor" /> <span>Love</span>
                {:else if discoveryVerdict === 'maybe'}
                  <Meh class="size-4 text-chart-3" /> <span>OK</span>
                {:else if discoveryVerdict === 'pass'}
                  <ThumbsDown class="size-4 text-(--text)/60" /> <span>Not for me</span>
                {:else}
                  <CircleHelp class="size-4 text-(--text)/45" /> <span>Unknown</span>
                {/if}
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unknown"><span class="flex items-center gap-2"><CircleHelp class="size-4 text-(--text)/45" /> Unknown</span></SelectItem>
                <SelectItem value="love"><span class="flex items-center gap-2"><Heart class="size-4 text-chart-5" fill="currentColor" /> Love</span></SelectItem>
                <SelectItem value="maybe"><span class="flex items-center gap-2"><Meh class="size-4 text-chart-3" /> OK</span></SelectItem>
                <SelectItem value="pass"><span class="flex items-center gap-2"><ThumbsDown class="size-4 text-(--text)/60" /> Not for me</span></SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="lg"
              class="gap-2 bg-(--bg-elevated)/72 backdrop-blur"
              disabled={!details}
              onclick={() => details && onToggleLibrary(details, show, day)}
            >
              {#if libraryEntry}<BookMarked class="size-4" /> Remove from library{:else}<BookmarkPlus class="size-4" /> Add to library{/if}
            </Button>
          </div>
          {#if trailerError}<p class="text-reveal mt-3 text-sm text-red-500">{trailerError}</p>{/if}
        </div>
      </div>
    </div>
  </section>

  <article class="relative z-10 mx-auto -mt-36 max-w-7xl px-5 pb-24 lg:-mt-48 lg:px-12">
    <section class="grid gap-10 border-b border-(--text)/8 pb-16 pt-8 md:grid-cols-[minmax(0,1.8fr)_minmax(13rem,0.7fr)] lg:gap-16 lg:pb-20 lg:pt-10" aria-labelledby="story-title">
      <div class="text-reveal">
        <p class="mb-3 text-[10px] font-medium uppercase tracking-[0.2em] text-(--text)/35">The story</p>
        <h2 id="story-title" class="text-2xl font-semibold tracking-[-0.045em]">What is this show about?</h2>
        {#if detailsLoading}
          <div class="mt-6 flex items-center gap-3 text-sm text-(--text)/45"><Spinner /> Loading show information…</div>
        {:else if details?.synopsis}
          <p class="text-reveal mt-6 max-w-3xl text-base leading-8 text-(--text)/62 lg:text-lg lg:leading-9">{decodeEntities(details.synopsis)}</p>
        {:else}
          <p class="mt-6 text-base leading-8 text-(--text)/45">No description has been found for this show yet.</p>
        {/if}
        {#if prominentTags.length}
          <div class="mt-8" aria-label="Show themes">
            <p class="mb-3 text-[10px] font-medium uppercase tracking-[0.18em] text-(--text)/32">Themes</p>
            <div class="flex flex-wrap gap-2">
              {#each prominentTags as tag (tag.id)}
                <Badge class="bg-(--text)/6 text-(--text)/52">{tag.name}{#if tag.rank}<span class="text-(--text)/28">{tag.rank}%</span>{/if}</Badge>
              {/each}
            </div>
          </div>
        {/if}
      </div>
      <dl class="text-reveal grid content-start grid-cols-2 gap-x-5 gap-y-6 border-t border-(--text)/8 pt-7 text-sm md:grid-cols-1 md:border-l md:border-t-0 md:pl-8 md:pt-1">
        {#if day}<div><dt class="text-(--text)/35">Airs</dt><dd class="mt-1 font-medium">{DAY_LABELS[day]} at {show.time}</dd></div>{/if}
        <div><dt class="text-(--text)/35">Available</dt><dd class="mt-1 font-medium">{Object.keys(details?.episode ?? {}).length}{details?.episode_count ? ` of ${details.episode_count}` : ''} episodes</dd></div>
        {#if libraryEntry}<div><dt class="text-(--text)/35">Watched</dt><dd class="mt-1 font-medium">{libraryEntry.watchedEpisodes.length} episodes</dd></div>{/if}
        {#if seasonLabel()}<div><dt class="text-(--text)/35">Season</dt><dd class="mt-1 font-medium">{seasonLabel()}</dd></div>{/if}
        {#if originalRun()}<div><dt class="text-(--text)/35">Original run</dt><dd class="mt-1 font-medium">{originalRun()}</dd></div>{/if}
        {#if details?.duration}<div><dt class="text-(--text)/35">Episode length</dt><dd class="mt-1 font-medium">About {details.duration} minutes</dd></div>{/if}
        {#if primaryStudios.length}<div><dt class="text-(--text)/35">Studio</dt><dd class="mt-1 font-medium">{primaryStudios.join(', ')}</dd></div>{/if}
        {#if details?.source}<div><dt class="text-(--text)/35">Source</dt><dd class="mt-1 font-medium">{metadataLabel(details.source)}</dd></div>{/if}
        {#if details?.country_of_origin}<div><dt class="text-(--text)/35">Origin</dt><dd class="mt-1 font-medium">{countryLabel(details.country_of_origin)}</dd></div>{/if}
        {#if details?.popularity}<div><dt class="text-(--text)/35">Popularity</dt><dd class="mt-1 font-medium">{popularityLabel(details.popularity)} AniList users</dd></div>{/if}
        {#if details?.metadata_source}<div><dt class="text-(--text)/35">Show data</dt><dd class="mt-1 font-medium">{details.metadata_source}</dd></div>{/if}
      </dl>
    </section>

    <section class="pt-16" aria-labelledby="episodes-title">
      <div class="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
        <div class="text-reveal">
          <p class="mb-2 text-[10px] font-medium uppercase tracking-[0.2em] text-(--text)/35">Ready to watch?</p>
          <h2 id="episodes-title" class="text-3xl font-semibold tracking-[-0.05em]">Episodes</h2>
          <p class="mt-3 text-sm text-(--text)/45">
            {Object.keys(details?.episode ?? {}).length} available{details?.episode_count ? ` of ${details.episode_count}` : ''} · watched episodes are tracked automatically{nextAiringLabel() ? ` · ${nextAiringLabel()}` : ''}
          </p>
        </div>
        <InputGroup class="w-full md:w-64">
          <InputGroupAddon><Search class="size-4" /></InputGroupAddon>
          <InputGroupInput bind:value={episodeQuery} oninput={() => (episodeLimit = 18)} placeholder="Search episodes…" aria-label="Search episodes" />
          {#if episodeQuery}
            <InputGroupAddon align="inline-end"><Button variant="ghost" size="icon" class="size-7" aria-label="Clear search" onclick={() => (episodeQuery = '')}><X class="size-3.5" /></Button></InputGroupAddon>
          {/if}
        </InputGroup>
      </div>

      {#if detailsLoading}
        <div class="mt-8 flex items-center gap-3 py-12 text-sm text-(--text)/45"><Spinner /> Loading episodes…</div>
      {:else if detailsError}
        <Alert variant="destructive" class="mt-8"><Tv2 class="size-4" /><AlertTitle>Show unavailable</AlertTitle><AlertDescription>{detailsError}</AlertDescription></Alert>
      {:else if details}
        <div class="mt-8 overflow-hidden rounded-3xl border border-(--text)/8 bg-(--bg-elevated)">
          <table class="w-full border-collapse text-left">
            <thead class="bg-(--text)/[0.035] text-[10px] font-semibold uppercase tracking-[0.14em] text-(--text)/36">
              <tr>
                <th class="px-5 py-3.5">Episode</th>
                <th class="hidden px-5 py-3.5 sm:table-cell">Release</th>
                <th class="px-5 py-3.5">Watched</th>
                <th class="px-5 py-3.5 text-right"><span class="sr-only">Action</span></th>
              </tr>
            </thead>
            <tbody>
              {#each episodes.slice(0, episodeLimit) as release (`${release.show}-${release.episode}`)}
                {@const preferred = preferredDownload(release, preferredQuality)}
                {@const releaseKey = `${release.show}-${release.episode}`}
                {@const watched = isWatched(release.episode)}
                {@const releasedToday = wasReleasedToday(release.release_date)}
                {@const supplement = episodeSupplements.get(episodeNumberKey(release.episode))}
                {@const image = supplement?.thumbnail ?? ''}
                <tr class="border-t border-(--text)/7 transition-colors hover:bg-(--text)/[0.025]">
                  <td class="px-5 py-4">
                    <div class="flex min-w-0 items-center gap-4">
                      <div class="relative hidden aspect-video w-28 shrink-0 overflow-hidden rounded-lg bg-(--text)/6 sm:block lg:w-32">
                        <Film class="absolute left-1/2 top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 text-(--text)/18" />
                        {#if image}
                          <RevealImage class="absolute inset-0 size-full object-cover" src={image} alt="" loading="lazy" reveal={mediaRevealReady} />
                        {/if}
                      </div>
                      <div class="min-w-0">
                        <span class="flex flex-wrap items-center gap-2">
                          <strong class="block text-sm">Episode {release.episode}</strong>
                          {#if releasedToday}<CheckCircle2 class="size-4 text-chart-1" aria-label="Released today" />{/if}
                        </span>
                        {#if supplement?.title}
                          <p class="mt-1 max-w-lg truncate text-sm text-(--text)/58" title={supplement.title}>{supplement.title}</p>
                        {/if}
                        <small class="mt-1 block text-[11px] text-(--text)/34">
                          {qualityLabel(release)}{supplement?.site ? ` · ${supplement.site} episode data` : ''}
                        </small>
                        <small class="mt-1 block text-(--text)/38 sm:hidden">{releaseDate(release.release_date)}</small>
                      </div>
                    </div>
                  </td>
                  <td class="hidden px-5 py-4 text-sm text-(--text)/48 sm:table-cell">{releaseDate(release.release_date)}</td>
                  <td class="px-5 py-4">
                    {#if libraryEntry}
                      <label class="inline-flex items-center gap-2.5 text-xs font-medium text-(--text)/55">
                        <Switch
                          checked={watched}
                          aria-label={watched ? `Mark episode ${release.episode} as unwatched` : `Mark episode ${release.episode} as watched`}
                          onCheckedChange={(checked) => checked !== watched && onToggleWatched(details?.slug || show.page, release.episode)}
                        />
                        <span class="hidden md:inline">{watched ? 'Watched' : 'Unwatched'}</span>
                      </label>
                    {:else}
                      <span class="text-xs text-(--text)/30">—</span>
                    {/if}
                  </td>
                  <td class="px-5 py-4 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      class="gap-2"
                      disabled={!preferred || playingKey === releaseKey}
                      onclick={() => void playRelease(releaseKey, release, preferred)}
                    >
                      {#if playingKey === releaseKey}<Spinner class="size-3.5" />{:else}<Play class="size-3.5" fill="currentColor" />{/if}
                      <span class="hidden sm:inline">Play</span>
                    </Button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if episodes.length === 0}<p class="py-16 text-center text-sm text-(--text)/45">No episodes found.</p>{/if}
        {#if episodes.length > episodeLimit}
          <Button variant="ghost" class="mt-6 w-full" onclick={() => (episodeLimit += 24)}>Show more <Badge class="ml-2">{episodes.length - episodeLimit}</Badge></Button>
        {/if}
      {/if}
    </section>
  </article>
  {/if}
</section>
