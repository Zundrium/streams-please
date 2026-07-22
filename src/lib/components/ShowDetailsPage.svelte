<script lang="ts">
  import { openUrl } from '@tauri-apps/plugin-opener';
  import {
    ArrowLeft,
    BookMarked,
    BookmarkPlus,
    CalendarDays,
    CheckCircle2,
    CircleHelp,
    ExternalLink,
    Film,
    Heart,
    Meh,
    Play,
    Search,
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
  import { isTauri } from '$lib/backend';
  import type {
    DayName,
    DiscoveryVerdict,
    EpisodePlaybackRequest,
    LibraryEntry,
    PlaybackQuality,
    SubsPleaseDownload,
    SubsPleaseRelease,
    SubsPleaseScheduleShow,
    SubsPleaseShowResponse
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
    show,
    day,
    libraryEntry,
    discoveryVerdict,
    loadShow,
    onBack,
    onPlay,
    onToggleLibrary,
    onSetDiscoveryVerdict,
    onToggleWatched,
    onShowLoaded,
    preferredQuality
  }: {
    show: SubsPleaseScheduleShow;
    day?: DayName;
    libraryEntry?: LibraryEntry;
    discoveryVerdict?: DiscoveryVerdict;
    loadShow: (slug: string, timezone: string) => Promise<SubsPleaseShowResponse>;
    onBack: () => void | Promise<void>;
    onPlay: (request: EpisodePlaybackRequest) => Promise<void>;
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
  } = $props();

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Amsterdam';
  const calendarDayFormatter = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: timezone
  });
  const todayCalendarDay = calendarDayFormatter.format(new Date());
  let details = $state<SubsPleaseShowResponse | null>(null);
  let detailsLoading = $state(true);
  let detailsError = $state('');
  let episodeQuery = $state('');
  let episodeLimit = $state(18);
  let playingKey = $state('');
  let trailerError = $state('');

  let episodes = $derived.by(() => {
    const all = Object.values(details?.episode ?? {});
    const term = episodeQuery.trim().toLowerCase();
    return (term
      ? all.filter((release) => `${release.show} ${release.episode}`.toLowerCase().includes(term))
      : all
    ).sort((left, right) => {
      const leftEpisode = Number.parseFloat(left.episode);
      const rightEpisode = Number.parseFloat(right.episode);
      if (Number.isFinite(leftEpisode) && Number.isFinite(rightEpisode)) return leftEpisode - rightEpisode;
      return new Date(left.release_date).getTime() - new Date(right.release_date).getTime();
    });
  });
  let exactTrailerUrl = $derived.by(() => {
    const trailer = details?.trailer;
    if (!trailer?.id) return '';
    if (trailer.site.toLowerCase() === 'youtube') {
      return `https://www.youtube.com/watch?v=${encodeURIComponent(trailer.id)}`;
    }
    if (trailer.site.toLowerCase() === 'dailymotion') {
      return `https://www.dailymotion.com/video/${encodeURIComponent(trailer.id)}`;
    }
    return '';
  });
  let trailerTargetUrl = $derived(
    exactTrailerUrl ||
      `https://www.youtube.com/results?search_query=${encodeURIComponent(`${details?.title || show.title} official trailer`)}`
  );

  $effect(() => {
    const activeShow = show;
    const activeDay = day;
    let cancelled = false;
    details = null;
    detailsLoading = true;
    detailsError = '';
    episodeQuery = '';
    episodeLimit = 18;
    trailerError = '';
    loadShow(activeShow.page, timezone)
      .then((nextDetails) => {
        if (cancelled) return;
        details = nextDetails;
        onShowLoaded(nextDetails, activeShow, activeDay);
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

  function releaseDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('en-US', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    }).format(date);
  }

  function wasReleasedToday(value: string): boolean {
    const date = new Date(value);
    return !Number.isNaN(date.getTime()) && calendarDayFormatter.format(date) === todayCalendarDay;
  }

  function metadataLabel(value: string): string {
    return value
      .toLowerCase()
      .replaceAll('_', ' ')
      .replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
  }

  function preferredDownload(release: SubsPleaseRelease): SubsPleaseDownload | undefined {
    return (
      release.downloads.find((download) => download.res === preferredQuality) ??
      [...release.downloads].sort((left, right) => Number(right.res) - Number(left.res))[0]
    );
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
    if (!trailerTargetUrl) return;
    trailerError = '';
    try {
      if (isTauri()) {
        await openUrl(trailerTargetUrl);
      } else {
        const opened = window.open(trailerTargetUrl, '_blank', 'noopener,noreferrer');
        if (!opened) throw new Error('The browser blocked the new window.');
      }
    } catch (reason) {
      trailerError = reason instanceof Error ? reason.message : String(reason);
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

<section class="h-full min-h-0 overflow-y-auto bg-(--bg) text-(--text)" aria-label={`${show.title} details`}>
  <header class="sticky top-0 z-40 -mb-16 flex h-16 items-center gap-2 border-b border-(--text)/8 bg-(--bg)/72 px-5 backdrop-blur-2xl lg:gap-4 lg:px-10">
    <Button variant="ghost" size="sm" class="gap-2 bg-(--bg-elevated)/60" onclick={() => void onBack()}>
      <ArrowLeft class="size-4" /> Back
    </Button>
    <Separator orientation="vertical" class="h-6" />
    <p class="min-w-0 truncate text-sm font-medium text-(--text)/60">{decodeEntities(show.title)}</p>
    <div class="flex-1"></div>
    <Select
      type="single"
      value={discoveryVerdict ?? 'unknown'}
      onValueChange={setDiscoveryVerdict}
    >
      <SelectTrigger
        class="h-9 min-w-36 bg-(--bg-elevated)/80"
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
      variant={libraryEntry ? 'ghost' : 'default'}
      size="sm"
      class="gap-2 bg-(--bg-elevated)/80"
      disabled={!details}
      onclick={() => details && onToggleLibrary(details, show, day)}
    >
      {#if libraryEntry}<BookMarked class="size-4" /> In library{:else}<BookmarkPlus class="size-4" /> Add{/if}
    </Button>
  </header>

  <section class="relative isolate min-h-[42rem] overflow-hidden lg:min-h-[52rem]" aria-label="Show introduction">
    {#if details?.banner_image_url || details?.image_url || show.image_url}
      <img
        class="absolute inset-0 -z-30 size-full scale-105 object-cover object-[center_28%] opacity-70 blur-[2px]"
        src={posterUrl(details?.banner_image_url || details?.image_url || show.image_url)}
        alt=""
      />
    {/if}
    <div class="absolute inset-0 -z-20 bg-gradient-to-r from-(--bg)/85 via-(--bg)/38 to-(--bg)/15"></div>
    <div
      class="absolute inset-0 -z-10"
      style="background: linear-gradient(to bottom, rgba(0, 0, 0, 0.14) 0%, transparent 38%, color-mix(in srgb, var(--bg) 22%, transparent) 62%, color-mix(in srgb, var(--bg) 72%, transparent) 80%, var(--bg) 96%);"
    ></div>

    <div class="mx-auto flex min-h-[42rem] max-w-7xl items-end px-6 pb-40 pt-36 lg:min-h-[52rem] lg:px-12 lg:pb-64">
      <div class="grid w-full items-end gap-7 md:grid-cols-[11rem_minmax(0,1fr)] lg:grid-cols-[13rem_minmax(0,1fr)]">
        <div class="hidden aspect-[3/4] overflow-hidden rounded-lg border border-white/15 bg-(--text)/5 shadow-2xl shadow-black/35 md:block">
          {#if details?.image_url || show.image_url}
            <img class="size-full object-cover" src={posterUrl(details?.image_url || show.image_url)} alt="" />
          {:else}
            <span class="grid size-full place-items-center"><Film class="size-10 text-(--text)/25" /></span>
          {/if}
        </div>
        <div class="pb-2 drop-shadow-sm">
          <div class="mb-4 flex flex-wrap gap-2">
            {#if day}
              <Badge class="bg-(--bg-elevated)/75 text-(--text)/70 backdrop-blur"><CalendarDays class="size-3" /> {DAY_LABELS[day]} · {show.time}</Badge>
            {:else}
              <Badge class="bg-(--bg-elevated)/75 text-(--text)/70 backdrop-blur"><BookMarked class="size-3" /> In your library</Badge>
            {/if}
            {#if details?.year}<Badge class="bg-(--bg-elevated)/75 backdrop-blur">{details.year}</Badge>{/if}
            {#if details?.format}<Badge class="bg-(--bg-elevated)/75 backdrop-blur">{metadataLabel(details.format)}</Badge>{/if}
            {#if details?.status}<Badge class="bg-(--bg-elevated)/75 backdrop-blur">{metadataLabel(details.status)}</Badge>{/if}
          </div>
          <h1 class="max-w-4xl text-4xl font-semibold leading-[0.98] tracking-[-0.06em] sm:text-5xl lg:text-7xl">
            {decodeEntities(details?.title || show.title)}
          </h1>
          {#if details?.genres?.length}
            <p class="mt-5 text-sm font-medium text-(--text)/55">{details.genres.slice(0, 4).join(' · ')}</p>
          {/if}
          <div class="mt-7 flex flex-wrap gap-2">
            <Button size="lg" class="gap-2" disabled={detailsLoading} onclick={() => void openTrailer()}>
              {#if detailsLoading}<Spinner class="size-4 border-(--bg)/20 border-t-(--bg)" />{:else}<Play class="size-4" fill="currentColor" />{/if}
              Watch trailer <ExternalLink class="size-3.5 opacity-55" />
            </Button>
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
          {#if trailerError}<p class="mt-3 text-sm text-red-500">{trailerError}</p>{/if}
        </div>
      </div>
    </div>
  </section>

  <article class="relative z-10 mx-auto -mt-36 max-w-7xl px-5 pb-24 lg:-mt-48 lg:px-12">
    <section class="grid gap-10 border-b border-(--text)/8 pb-16 pt-8 md:grid-cols-[minmax(0,1.8fr)_minmax(13rem,0.7fr)] lg:gap-16 lg:pb-20 lg:pt-10" aria-labelledby="story-title">
      <div>
        <p class="mb-3 text-[10px] font-medium uppercase tracking-[0.2em] text-(--text)/35">The story</p>
        <h2 id="story-title" class="text-2xl font-semibold tracking-[-0.045em]">What is this show about?</h2>
        {#if detailsLoading}
          <div class="mt-6 flex items-center gap-3 text-sm text-(--text)/45"><Spinner /> Loading show information…</div>
        {:else if details?.synopsis}
          <p class="mt-6 max-w-3xl text-base leading-8 text-(--text)/62 lg:text-lg lg:leading-9">{decodeEntities(details.synopsis)}</p>
        {:else}
          <p class="mt-6 text-base leading-8 text-(--text)/45">No description has been found for this show yet.</p>
        {/if}
      </div>
      <dl class="grid content-start grid-cols-2 gap-x-5 gap-y-6 border-t border-(--text)/8 pt-7 text-sm md:grid-cols-1 md:border-l md:border-t-0 md:pl-8 md:pt-1">
        {#if day}<div><dt class="text-(--text)/35">Airs</dt><dd class="mt-1 font-medium">{DAY_LABELS[day]} at {show.time}</dd></div>{/if}
        <div><dt class="text-(--text)/35">Available</dt><dd class="mt-1 font-medium">{Object.keys(details?.episode ?? {}).length} episodes</dd></div>
        {#if libraryEntry}<div><dt class="text-(--text)/35">Watched</dt><dd class="mt-1 font-medium">{libraryEntry.watchedEpisodes.length} episodes</dd></div>{/if}
        {#if details?.year}<div><dt class="text-(--text)/35">Year</dt><dd class="mt-1 font-medium">{details.year}</dd></div>{/if}
        {#if details?.metadata_source}<div><dt class="text-(--text)/35">Show data</dt><dd class="mt-1 font-medium">{details.metadata_source}</dd></div>{/if}
      </dl>
    </section>

    <section class="pt-16" aria-labelledby="episodes-title">
      <div class="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
        <div>
          <p class="mb-2 text-[10px] font-medium uppercase tracking-[0.2em] text-(--text)/35">Ready to watch?</p>
          <h2 id="episodes-title" class="text-3xl font-semibold tracking-[-0.05em]">Episodes</h2>
          <p class="mt-3 text-sm text-(--text)/45">{Object.keys(details?.episode ?? {}).length} available · watched episodes are tracked automatically</p>
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
                <th class="hidden px-5 py-3.5 sm:table-cell">Date</th>
                <th class="px-5 py-3.5">Watched</th>
                <th class="px-5 py-3.5 text-right"><span class="sr-only">Action</span></th>
              </tr>
            </thead>
            <tbody>
              {#each episodes.slice(0, episodeLimit) as release (`${release.show}-${release.episode}`)}
                {@const preferred = preferredDownload(release)}
                {@const releaseKey = `${release.show}-${release.episode}`}
                {@const watched = isWatched(release.episode)}
                {@const releasedToday = wasReleasedToday(release.release_date)}
                <tr class="border-t border-(--text)/7 transition-colors hover:bg-(--text)/[0.025]">
                  <td class="px-5 py-3.5">
                    <span class="flex flex-wrap items-center gap-2">
                      <strong class="block text-sm">Episode {release.episode}</strong>
                      {#if releasedToday}<CheckCircle2 class="size-4 text-chart-1" aria-label="Released today" />{/if}
                    </span>
                    <small class="mt-0.5 block text-(--text)/38 sm:hidden">{releaseDate(release.release_date)}</small>
                  </td>
                  <td class="hidden px-5 py-3.5 text-sm text-(--text)/48 sm:table-cell">{releaseDate(release.release_date)}</td>
                  <td class="px-5 py-3.5">
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
                  <td class="px-5 py-3.5 text-right">
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
</section>
