<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import {
    command as mpvCommand,
    destroy as destroyMpv,
    getProperty,
    init as initMpv,
    listenEvents,
    observeProperties,
    setProperty,
    setVideoMarginRatio,
    type MpvEvent,
    type MpvEventFromProperties,
    type MpvObservableProperty
  } from 'tauri-plugin-libmpv-api';
  import {
    AlertCircle,
    AudioLines,
    BookOpen,
    CalendarDays,
    Check,
    CircleUserRound,
    FileVideo2,
    Languages,
    MonitorPlay,
    Play,
    Sparkles,
    X
  } from '@lucide/svelte';
  import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import {
    Card,
    CardContent
  } from '$lib/components/ui/card';
  import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger
  } from '$lib/components/ui/select';
  import { Spinner } from '$lib/components/ui/spinner';
  import { Switch } from '$lib/components/ui/switch';
  import { Tabs, TabsList, TabsTrigger } from '$lib/components/ui/tabs';
  import { callBackend, isTauri } from '$lib/backend';
  import {
    currentSeason,
    loadCachedProviderIndex,
    loadCachedSeason,
    saveCachedProviderIndex,
    saveCachedSeason
  } from '$lib/catalog';
  import {
    entryFromDiscovery,
    entryFromShow,
    libraryEntryMatches,
    loadLibrary,
    saveLibrary,
    sortEpisodeNumbers
  } from '$lib/library';
  import { loadSettings, saveSettings } from '$lib/settings';
  import {
    TrailerPlayerController,
    type TrailerPlaybackState
  } from '$lib/trailer-player';
  import { isYoutubeTrailerSearchPlaybackUrl } from '$lib/trailers';
  import AccountSettingsPage from '$lib/components/AccountSettingsPage.svelte';
  import DiscoveryPage from '$lib/components/DiscoveryPage.svelte';
  import LibraryPage from '$lib/components/LibraryPage.svelte';
  import PlayerTransport from '$lib/components/PlayerTransport.svelte';
  import RevealImage from '$lib/components/RevealImage.svelte';
  import SubsPleasePage from '$lib/components/SubsPleasePage.svelte';
  import StreamsPleaseLogo from '$lib/components/StreamsPleaseLogo.svelte';
  import TasteIndicator from '$lib/components/TasteIndicator.svelte';
  import type {
    AddTorrentResponse,
    AnimeSeason,
    AniListSeasonResponse,
    AppView,
    CurrentTorrent,
    DayName,
    DiscoveryVerdict,
    EpisodePlaybackRequest,
    LibraryEntry,
    MpvTrack,
    Phase,
    PlaybackQuality,
    PlaybackState,
    RuntimeInfo,
    SubtitleLanguage,
    SubsPleaseIndexResponse,
    SubsPleaseScheduleResponse,
    SubsPleaseScheduleShow,
    SubsPleaseShowResponse,
    TrailerPlaybackRequest,
    TorrentStats
  } from '$lib/types';

  type TrailerResumeState = {
    torrent: CurrentTorrent;
    playback: PlaybackState;
    tracks: MpvTrack[];
  };

  type PlaybackBufferRange = {
    start: number;
    end: number;
  };

  type TrailerPlacement = {
    left: number;
    top: number;
    width: number;
    height: number;
  };

  type TrailerSessionContext = {
    originView: AppView;
    inlineAnchor: HTMLElement | null;
    inlineAnchorVisibility: string;
    resume: TrailerResumeState | null;
    requiresEpisodeReload: boolean;
    returnTheaterMode: boolean;
    returnFullscreenMode: boolean;
  };

  type MpvMediaOwner = 'episode' | 'trailer' | 'transition';

  type MpvLoadWaiter = {
    expectedPathPrefix: string;
    resolve: () => void;
    reject: (reason: Error) => void;
    timer: number;
  };

  const seasonCatalogRequests = new Map<string, Promise<AniListSeasonResponse>>();
  let subspleaseIndexRequest: Promise<SubsPleaseIndexResponse> | null = null;
  const PROVIDER_INDEX_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const CURRENT_SEASON_CACHE_MAX_AGE_MS = 15 * 60 * 1000;
  const FUTURE_SEASON_CACHE_MAX_AGE_MS = 60 * 60 * 1000;
  const PAST_SEASON_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const SEASON_ORDER: AnimeSeason[] = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];

  const OBSERVED_PROPERTIES = [
    ['pause', 'flag'],
    ['time-pos', 'double', 'none'],
    ['duration', 'double', 'none'],
    ['volume', 'double'],
    ['mute', 'flag'],
    ['speed', 'double'],
    ['track-list', 'node'],
    ['media-title', 'string', 'none'],
    ['path', 'string', 'none'],
    ['paused-for-cache', 'flag']
  ] as const satisfies readonly MpvObservableProperty[];
  const VIDEO_EXTENSIONS = ['.mkv', '.mk3d', '.mp4', '.m4v', '.mov', '.webm', '.avi', '.ts', '.m2ts'];
  const MIN_STREAM_START_BYTES = 1024 * 1024;
  const STREAM_RETRY_DELAY_MS = 5_000;
  const MAX_STREAM_FAILURES = 3;
  const PLAYBACK_START_TIMEOUT_MS = 20_000;
  const PLAYBACK_PROBE_INTERVAL_MS = 250;
  const SEEK_RECONCILE_TOLERANCE_SECONDS = 1;
  const MEDIA_LOAD_TIMEOUT_MS = 8_000;
  const MPV_WINDOW_LABEL = 'main';

  let contentViewport = $state<HTMLElement | null>(null);
  let videoViewport = $state<HTMLElement | null>(null);
  let trailerViewport = $state<HTMLElement | null>(null);
  let trailerInlineAnchor: HTMLElement | null = null;
  let trailerPlacement = $state<TrailerPlacement | null>(null);
  let mpvReady = false;
  let mpvInitPromise: Promise<void> | null = null;
  let mpvUnlisten: (() => void) | null = null;
  let mpvEventUnlisten: (() => void) | null = null;
  let bufferingStartedAt = 0;
  let currentRef: CurrentTorrent | null = null;
  let statsRef: TorrentStats | null = null;
  let streamStarted = false;
  let streamFailures = 0;
  let nextStreamRetryAt = 0;
  let streamAttemptGeneration = 0;
  let bufferingWatchdogTimer: number | null = null;
  let mpvPausedForCache = false;
  let pendingSeekTime: number | null = null;
  let seekOperation: Promise<void> | null = null;
  let seekGeneration = 0;
  let playerUiTimer: number | null = null;
  let trailerOriginView = $state<AppView | null>(null);
  let mpvMediaOwner: MpvMediaOwner = 'episode';
  let mpvLoadWaiter: MpvLoadWaiter | null = null;
  const pendingEpisodeMediaOperations = new Set<Promise<void>>();

  let runtime = $state<RuntimeInfo | null>(null);
  let activeView = $state<AppView>('library');
  let activeViewRequestGeneration = 0;
  let libraryEntries = $state<LibraryEntry[]>([]);
  let playingEpisode = $state<EpisodePlaybackRequest | null>(null);
  let requestedShowSlug = $state('');
  let theaterMode = $state(false);
  let fullscreenMode = $state(false);
  let playerUiVisible = $state(true);
  let preferredQuality = $state<PlaybackQuality>('1080');
  let preferredSubtitleLanguage = $state<SubtitleLanguage>('en');
  let autoMarkedPlaybackKey = '';
  let phase = $state<Phase>('idle');
  let error = $state('');
  let current = $state<CurrentTorrent | null>(null);
  let stats = $state<TorrentStats | null>(null);
  let queueOpen = $state(false);
  let tracks = $state<MpvTrack[]>([]);
  let seekTarget = $state<number | null>(null);
  let playback = $state<PlaybackState>({
    paused: true,
    time: 0,
    duration: 0,
    volume: 80,
    muted: false,
    speed: 1
  });
  let trailerPlayback = $state<TrailerPlaybackState | null>(null);
  let trailerLoadedPath = $state('');
  let trailerOutgoingPath = '';
  const trailerController = new TrailerPlayerController<TrailerSessionContext>(
    {
      open: openTrailerSession,
      prepare: prepareTrailerSession,
      load: loadTrailerMedia,
      abort: abortTrailerSession,
      teardown: teardownTrailerSession,
      setPaused: (paused) => runWithMpv(() => setProperty('pause', paused, MPV_WINDOW_LABEL)),
      seek: (time) =>
        runWithMpv(() => mpvCommand('seek', [time, 'absolute+exact'], MPV_WINDOW_LABEL)),
      setVolume: (volume) =>
        runWithMpv(() => setProperty('volume', volume, MPV_WINDOW_LABEL)),
      setMuted: (muted) => runWithMpv(() => setProperty('mute', muted, MPV_WINDOW_LABEL))
    },
    (state) => {
      const startedLoading =
        state?.status === 'searching' && trailerPlayback?.status !== 'searching';
      const becameReady =
        (state?.status === 'ready' || state?.status === 'buffering') &&
        trailerPlayback?.status === 'searching';
      trailerPlayback = state;
      if (startedLoading) {
        trailerOutgoingPath = trailerLoadedPath;
        trailerLoadedPath = '';
      }
      if (startedLoading || becameReady) scheduleVideoViewportSync();
    },
    (message) => {
      phase = 'error';
      error = `The trailer player could not close cleanly: ${message}`;
    }
  );

  let videoTitle = $derived(current ? readableTitle(current.video.name) : 'Nothing played yet');
  let nowPlayingTitle = $derived(
    playingEpisode
      ? `${playingEpisode.title} · Episode ${playingEpisode.episode}`
      : videoTitle
  );
  let subtitleTracks = $derived(tracks.filter((track) => track.type === 'sub'));
  let audioTracks = $derived(tracks.filter((track) => track.type === 'audio'));
  let selectedSubtitle = $derived(subtitleTracks.find((track) => track.selected));
  let selectedAudio = $derived(audioTracks.find((track) => track.selected));
  let displayedPlaybackTime = $derived(seekTarget ?? playback.time);
  let displayedPlaybackProgress = $derived(
    playback.duration ? (displayedPlaybackTime / playback.duration) * 100 : 0
  );
  let bufferedPlaybackRanges = $derived(
    torrentPieceRanges(stats, current, playback.duration)
  );
  let trailerPlaybackProgress = $derived(
    trailerPlayback?.duration
      ? Math.max(0, Math.min(100, (trailerPlayback.time / trailerPlayback.duration) * 100))
      : 0
  );
  let trailerReady = $derived(
    (trailerPlayback?.status === 'ready' || trailerPlayback?.status === 'buffering') &&
      Boolean(trailerLoadedPath)
  );
  let immersiveMode = $derived(theaterMode || fullscreenMode);
  let trailerInlineMode = $derived(
    Boolean(trailerPlayback && trailerPlacement && !immersiveMode)
  );
  let trailerPlayerStyle = $derived.by(() => {
    if (!trailerInlineMode || !trailerPlacement) return '';
    return `left:${trailerPlacement.left}px;top:${trailerPlacement.top}px;width:${trailerPlacement.width}px;height:${trailerPlacement.height}px`;
  });
  let trailerPlayerOpen = $derived(Boolean(trailerPlayback));
  let episodePlayerOpen = $derived(Boolean(current) && activeView === 'player');
  let livePeers = $derived(stats?.live?.snapshot.peer_stats.live ?? 0);
  let downloadSpeed = $derived(stats?.live?.download_speed.mbps ?? 0);
  let downloadSpeedLabel = $derived(
    stats?.live?.download_speed.human_readable ??
      (downloadSpeed > 0 ? `${downloadSpeed.toFixed(2)} MiB/s` : '0 B/s')
  );
  let torrentDownloaded = $derived(
    Boolean(
      current &&
        stats &&
        (stats.finished ||
          (stats.file_progress?.[current.fileId] ?? 0) >= current.video.length)
    )
  );
  let waitingForPeers = $derived(
    phase === 'buffering' &&
      Date.now() - bufferingStartedAt > 12_000 &&
      livePeers === 0 &&
      downloadSpeed === 0
  );
  let bitrateLabel = $derived(
    tracks.find((track) => track.type === 'video')?.codec?.toUpperCase() ??
      (current?.video.name.toLowerCase().endsWith('.mkv') ? 'MKV' : 'AUTO')
  );
  let playingLibraryEntry = $derived(
    playingEpisode
      ? libraryEntries.find(
          (entry) =>
            entry.following &&
            libraryEntryMatches(entry, playingEpisode?.anilistId, playingEpisode?.slug)
        )
      : undefined
  );
  let playingEpisodeWatched = $derived(
    Boolean(
      playingEpisode &&
        playingLibraryEntry?.watchedEpisodes.includes(playingEpisode.episode)
    )
  );

  onMount(() => {
    libraryEntries = loadLibrary();
    const settings = loadSettings();
    preferredQuality = settings.preferredQuality;
    preferredSubtitleLanguage = settings.preferredSubtitleLanguage;
    void callBackend<RuntimeInfo>('runtime_info')
      .then((nextRuntime) => (runtime = nextRuntime))
      .catch((reason) => (error = String(reason)));

    const onResize = () => {
      updateTrailerPlacement();
      void syncVideoViewport();
      if (isTauri()) {
        void getCurrentWindow()
          .isFullscreen()
          .then((nextFullscreenMode) => (fullscreenMode = nextFullscreenMode))
          .catch(() => undefined);
      }
    };
    const onScroll = () => {
      if (!trailerInlineAnchor || immersiveMode) return;
      updateTrailerPlacement();
      void syncVideoViewport();
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    onResize();

    const onVisibilityChange = () => {
      if (!document.hidden) return;
      if (trailerPlayback) void pauseTrailerPlayback();
      else void pausePlayback();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && queueOpen) {
        queueOpen = false;
        return;
      }
      if (event.key === 'Escape' && fullscreenMode) {
        void toggleFullscreen(false);
        return;
      }
      if (event.key === 'Escape' && trailerPlayback) {
        void closeTrailer();
        return;
      }
      if (event.key === 'Escape' && theaterMode) {
        toggleTheater(false);
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, button')) return;
      if (trailerPlayback) {
        if (event.code === 'Space') {
          event.preventDefault();
          void toggleTrailerPlayback();
        } else if (event.code === 'ArrowLeft') {
          void seekTrailerRelative(-10);
        } else if (event.code === 'ArrowRight') {
          void seekTrailerRelative(10);
        } else if (event.key.toLowerCase() === 'm') {
          void toggleTrailerMute();
        } else if (event.key.toLowerCase() === 'f') {
          void toggleFullscreen();
        }
        return;
      }
      if (!currentRef) return;
      if (event.code === 'Space') {
        event.preventDefault();
        void togglePlayback();
      } else if (event.code === 'ArrowLeft') {
        seekRelative(-10);
      } else if (event.code === 'ArrowRight') {
        seekRelative(10);
      } else if (event.key.toLowerCase() === 'm') {
        void toggleMute();
      } else if (event.key.toLowerCase() === 'f') {
        void toggleFullscreen();
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (playerUiTimer !== null) window.clearTimeout(playerUiTimer);
      rejectMpvLoadWaiter(new Error('The player was closed.'));
      trailerController.dispose();
      clearBufferingWatchdog();
      seekGeneration += 1;
      mpvUnlisten?.();
      mpvEventUnlisten?.();
    };
  });

  $effect(() => {
    const viewport = trailerPlayback ? trailerViewport : videoViewport;
    if (!viewport) return;
    const observer = new ResizeObserver(() => void syncVideoViewport());
    observer.observe(viewport);
    return () => observer.disconnect();
  });

  $effect(() => {
    const playerOpen = trailerPlayerOpen;
    const anchor = trailerInlineAnchor;
    const host = contentViewport;
    if (!playerOpen || !anchor || !host) return;

    const syncOrClose = () => {
      if (anchor.isConnected) {
        scheduleVideoViewportSync();
        return;
      }
      if (trailerPlayback?.status !== 'closing') void closeTrailer();
    };
    const observer = new MutationObserver(syncOrClose);
    observer.observe(host, { childList: true, subtree: true });
    syncOrClose();
    return () => observer.disconnect();
  });

  $effect(() => {
    const id = current?.id;
    if (id === undefined) return;
    const update = () => {
      void callBackend<TorrentStats>('torrent_status', { id })
        .then((nextStats) => {
          statsRef = nextStats;
          stats = nextStats;
        })
        .catch(() => undefined);
    };
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  });

  $effect(() => {
    const view = activeView;
    const trailer = trailerPlayback;
    if (view !== 'player' && current && !trailer) void pausePlayback();
  });

  $effect(() => {
    const view = activeView;
    const origin = trailerOriginView;
    if (!trailerPlayback || !origin || view === origin) return;
    trailerOriginView = null;
    void closeTrailer();
  });

  $effect(() => {
    const view = activeView;
    const theater = theaterMode;
    const trailer = trailerPlayback;
    if (!isTauri() || !mpvReady) return;
    if (trailer) {
      window.requestAnimationFrame(() => void syncVideoViewport());
    } else if (view !== 'player') {
      void runWithMpv(() =>
        setVideoMarginRatio({ left: 0, right: 0, top: 1, bottom: 0 }, MPV_WINDOW_LABEL)
      ).catch(() => undefined);
    } else {
      window.requestAnimationFrame(() => void syncVideoViewport());
    }
  });

  $effect(() => {
    const hasActivePlayer = trailerPlayerOpen || episodePlayerOpen;
    if (hasActivePlayer) {
      revealPlayerUi();
    } else if (playerUiTimer !== null) {
      window.clearTimeout(playerUiTimer);
      playerUiTimer = null;
      playerUiVisible = true;
    }
  });

  $effect(() => {
    if (stats?.state === 'error' && stats.error) {
      phase = 'error';
      error = `Torrent-engine: ${stats.error}`;
    }
  });

  $effect(() => {
    const episode = playingEpisode;
    const duration = playback.duration;
    const time = playback.time;
    if (!episode || duration <= 0 || time / duration < 0.8) return;
    const key = `${episode.slug}:${episode.episode}`;
    if (autoMarkedPlaybackKey === key) return;
    autoMarkedPlaybackKey = key;
    setEpisodeWatched(episode.slug, episode.episode, true);
  });

  $effect(() => {
    const target = current;
    const nextStats = stats;
    if (
      !isTauri() ||
      mpvMediaOwner !== 'episode' ||
      trailerPlayback !== null ||
      !target ||
      !nextStats ||
      nextStats.state === 'error' ||
      streamStarted ||
      streamFailures >= MAX_STREAM_FAILURES ||
      Date.now() < nextStreamRetryAt
    ) {
      return;
    }
    const selectedFileProgress = nextStats.file_progress?.[target.fileId] ?? nextStats.progress_bytes;
    if (!nextStats.finished && selectedFileProgress < MIN_STREAM_START_BYTES) return;

    const attempt = ++streamAttemptGeneration;
    streamStarted = true;
    void openTorrentStream(target, attempt).catch((reason) => {
      if (attempt !== streamAttemptGeneration) return;
      handleStreamFailure(reason instanceof Error ? reason.message : String(reason), attempt);
    });
  });

  $effect(() => {
    if (isTauri() || !current || playback.paused || !playback.duration) return;
    const interval = window.setInterval(() => {
      playback = {
        ...playback,
        time: Math.min(playback.duration, playback.time + 0.25)
      };
    }, 250);
    return () => window.clearInterval(interval);
  });

  function formatBytes(bytes = 0): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / 1024 ** index;
    return `${value.toFixed(index > 2 ? 2 : index > 0 ? 1 : 0)} ${units[index]}`;
  }

  function readableTitle(filename: string): string {
    return filename
      .replace(/\.[^.]+$/, '')
      .replace(/^\[[^\]]+\]\s*/, '')
      .replace(/[._]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function preferredSubtitleLanguages(): string {
    return preferredSubtitleLanguage === 'en'
      ? 'en'
      : `${preferredSubtitleLanguage},en`;
  }

  function normalizeTracks(value: unknown): MpvTrack[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const source = item as Record<string, unknown>;
      if (source.type !== 'video' && source.type !== 'audio' && source.type !== 'sub') return [];
      return [
        {
          id: Number(source.id),
          type: source.type,
          lang: typeof source.lang === 'string' ? source.lang : undefined,
          title: typeof source.title === 'string' ? source.title : undefined,
          codec: typeof source.codec === 'string' ? source.codec : undefined,
          selected: Boolean(source.selected),
          external: Boolean(source.external)
        }
      ];
    });
  }

  function inferPieceLength(totalBytes: number, pieceSlots: number): number {
    if (totalBytes <= 0 || pieceSlots <= 0) return 0;
    for (let exponent = 14; exponent <= 26; exponent += 1) {
      const candidate = 2 ** exponent;
      const actualPieces = Math.ceil(totalBytes / candidate);
      if (actualPieces <= pieceSlots && pieceSlots - actualPieces < 8) return candidate;
    }
    return totalBytes / pieceSlots;
  }

  function torrentPieceRanges(
    torrentStats: TorrentStats | null,
    torrent: CurrentTorrent | null,
    duration: number
  ): PlaybackBufferRange[] {
    const pieces = torrentStats?.pieces;
    const files = torrent?.details.files;
    if (!pieces?.length || !torrent || !files?.length || duration <= 0) return [];

    const totalBytes =
      torrentStats?.total_bytes || files.reduce((sum, file) => sum + file.length, 0);
    const pieceLength = inferPieceLength(totalBytes, pieces.length);
    const fileLength = torrent.video.length;
    if (pieceLength <= 0 || fileLength <= 0) return [];

    const fileStart = files
      .slice(0, torrent.fileId)
      .reduce((sum, file) => sum + file.length, 0);
    const fileEnd = fileStart + fileLength;
    const firstPiece = Math.max(0, Math.floor(fileStart / pieceLength));
    const lastPiece = Math.min(pieces.length - 1, Math.ceil(fileEnd / pieceLength) - 1);
    const visualMergeGap = Math.min(
      0.5,
      Math.max(0.12, (pieceLength / fileLength) * 100 * 2)
    );
    const ranges: PlaybackBufferRange[] = [];

    for (let index = firstPiece; index <= lastPiece; index += 1) {
      if (!pieces[index]) continue;
      const startByte = Math.max(fileStart, index * pieceLength);
      const endByte = Math.min(fileEnd, (index + 1) * pieceLength);
      const range = {
        start: ((startByte - fileStart) / fileLength) * 100,
        end: ((endByte - fileStart) / fileLength) * 100
      };
      const previous = ranges[ranges.length - 1];
      if (previous && range.start <= previous.end + visualMergeGap) {
        previous.end = Math.max(previous.end, range.end);
      } else {
        ranges.push(range);
      }
    }

    return ranges;
  }

  function updateTrailerPlacement() {
    if (!trailerInlineAnchor || !contentViewport || !trailerInlineAnchor.isConnected) return;
    const anchor = trailerInlineAnchor.getBoundingClientRect();
    const host = contentViewport.getBoundingClientRect();
    trailerPlacement = {
      left: anchor.left - host.left,
      top: anchor.top - host.top,
      width: anchor.width,
      height: anchor.height
    };
  }

  function currentVideoMargins() {
    const viewport = trailerPlayback ? trailerViewport : videoViewport;
    if (!viewport) return null;
    const rect = viewport.getBoundingClientRect();
    const width = window.innerWidth;
    const height = window.innerHeight;
    return {
      left: Math.max(0, rect.left / width),
      right: Math.max(0, (width - rect.right) / width),
      top: Math.max(0, rect.top / height),
      bottom: Math.max(0, (height - rect.bottom) / height)
    };
  }

  function resetMpvClient() {
    mpvReady = false;
    rejectMpvLoadWaiter(new Error('The mpv instance was reset during a media load.'));
    mpvUnlisten?.();
    mpvEventUnlisten?.();
    mpvUnlisten = null;
    mpvEventUnlisten = null;
  }

  function isMissingMpvInstance(reason: unknown): boolean {
    const message = reason instanceof Error ? reason.message : String(reason);
    return (
      message.includes('is not initialized') ||
      message.includes('mpv instance not found') ||
      message.includes('mpv worker failed') ||
      message.includes('JoinError::Panic')
    );
  }

  async function runWithMpv<T>(operation: () => Promise<T>): Promise<T> {
    await ensureMpv();
    try {
      return await operation();
    } catch (reason) {
      if (!isMissingMpvInstance(reason)) throw reason;
      resetMpvClient();
      await ensureMpv();
      return operation();
    }
  }

  async function syncVideoViewport() {
    if (!isTauri() || !mpvReady || mpvMediaOwner === 'transition') return;
    const margins = currentVideoMargins();
    if (!margins) return;
    await runWithMpv(() => setVideoMarginRatio(margins, MPV_WINDOW_LABEL));
  }

  function scheduleVideoViewportSync() {
    const sync = () => {
      updateTrailerPlacement();
      void syncVideoViewport();
    };
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(sync);
    });
    window.setTimeout(sync, 180);
    window.setTimeout(sync, 320);
  }

  function isSupportedTrailerUrl(value: string): boolean {
    if (isYoutubeTrailerSearchPlaybackUrl(value)) return true;
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      return (
        url.protocol === 'https:' &&
        (host === 'youtube.com' ||
          host.endsWith('.youtube.com') ||
          host === 'youtu.be' ||
          host === 'dailymotion.com' ||
          host.endsWith('.dailymotion.com'))
      );
    } catch {
      return false;
    }
  }

  function suspendEpisodeOperations(): void {
    streamAttemptGeneration += 1;
    seekGeneration += 1;
    clearBufferingWatchdog();
    pendingSeekTime = null;
    seekTarget = null;
  }

  function trackEpisodeMediaOperation(operation: Promise<void>): Promise<void> {
    pendingEpisodeMediaOperations.add(operation);
    operation.then(
      () => pendingEpisodeMediaOperations.delete(operation),
      () => pendingEpisodeMediaOperations.delete(operation)
    );
    return operation;
  }

  function openTrailerSession(request: TrailerPlaybackRequest): TrailerSessionContext {
    const inlineAnchor = request.viewport?.isConnected ? request.viewport : null;
    const context: TrailerSessionContext = {
      originView: activeView,
      inlineAnchor,
      inlineAnchorVisibility: inlineAnchor?.style.visibility ?? '',
      resume: currentRef
        ? { torrent: currentRef, playback: { ...playback, paused: true }, tracks: [...tracks] }
        : null,
      requiresEpisodeReload: Boolean(currentRef && phase !== 'ready'),
      returnTheaterMode: theaterMode,
      returnFullscreenMode: fullscreenMode
    };

    suspendEpisodeOperations();
    trailerOriginView = context.originView;
    trailerInlineAnchor = inlineAnchor;
    trailerPlacement = null;
    updateTrailerPlacement();
    if (inlineAnchor) inlineAnchor.style.visibility = 'hidden';
    return context;
  }

  async function prepareTrailerSession(
    context: TrailerSessionContext,
    request: TrailerPlaybackRequest,
    _initial: TrailerPlaybackState,
    cancelled: () => boolean
  ): Promise<void> {
    if (!isSupportedTrailerUrl(request.url)) {
      throw new Error('This trailer provider is not supported by the desktop player.');
    }

    const pendingEpisodeOperations = [...pendingEpisodeMediaOperations];
    if (pendingEpisodeOperations.length) {
      await Promise.allSettled(pendingEpisodeOperations);
    }
    if (cancelled()) return;
    if (currentRef && !playback.paused) await pausePlayback();
    if (cancelled()) return;
    if (context.resume && currentRef) {
      context.resume = {
        torrent: currentRef,
        playback: { ...playback, paused: true },
        tracks: [...tracks]
      };
    }

    const nextRuntime = runtime ?? (await callBackend<RuntimeInfo>('runtime_info'));
    if (cancelled()) return;
    runtime = nextRuntime;
    if (!nextRuntime.mpvAvailable) {
      throw new Error('The bundled in-process video engine is unavailable.');
    }
    if (!nextRuntime.trailerAvailable) {
      throw new Error('The bundled YouTube trailer resolver is unavailable.');
    }

    await ensureMpv();
    if (cancelled()) return;
    mpvMediaOwner = 'transition';
    await tick();
    if (cancelled()) return;
    updateTrailerPlacement();
    mpvMediaOwner = 'trailer';
    await syncVideoViewport();
  }

  async function loadTrailerMedia(
    request: TrailerPlaybackRequest,
    initial: TrailerPlaybackState,
    cancelled: () => boolean,
    replacing: boolean
  ): Promise<void> {
    if (replacing) {
      mpvMediaOwner = 'transition';
      await tick();
      if (cancelled()) return;
      await runWithMpv(() =>
        setVideoMarginRatio({ top: 1 }, MPV_WINDOW_LABEL)
      );
      if (cancelled()) return;
    }

    mpvMediaOwner = 'trailer';
    await runWithMpv(async () => {
      await setProperty('speed', 1, MPV_WINDOW_LABEL);
      if (cancelled()) return;
      await setProperty('volume', initial.volume, MPV_WINDOW_LABEL);
      if (cancelled()) return;
      await setProperty('mute', initial.muted, MPV_WINDOW_LABEL);
      if (cancelled()) return;
      await mpvCommand(
        'loadfile',
        [
          request.url,
          'replace',
          -1,
          'pause=no,start=0,speed=1,vid=auto,aid=auto,sid=no,secondary-sid=no'
        ],
        MPV_WINDOW_LABEL
      );
    });
  }

  async function abortTrailerSession(
    context: TrailerSessionContext,
    mediaWasReplaced: boolean
  ): Promise<void> {
    mpvMediaOwner = 'transition';
    await stopTrailerMedia(context, mediaWasReplaced);
  }

  async function teardownTrailerSession(
    context: TrailerSessionContext,
    mediaWasReplaced: boolean
  ): Promise<void> {
    mpvMediaOwner = 'transition';
    await stopTrailerMedia(context, mediaWasReplaced);

    theaterMode = context.returnTheaterMode;
    if (isTauri() && fullscreenMode !== context.returnFullscreenMode) {
      await getCurrentWindow()
        .setFullscreen(context.returnFullscreenMode)
        .then(() => (fullscreenMode = context.returnFullscreenMode))
        .catch(() => undefined);
    }

    try {
      const resume = context.resume;
      const sameTorrent =
        resume &&
        currentRef &&
        resume.torrent.id === currentRef.id &&
        resume.torrent.fileId === currentRef.fileId;
      const shouldReloadEpisode = mediaWasReplaced || context.requiresEpisodeReload;
      if (isTauri() && shouldReloadEpisode && sameTorrent && resume) {
        await restoreEpisodeAfterTrailer(resume);
      } else if (resume) {
        playback = { ...resume.playback, paused: true };
        tracks = resume.tracks;
      }
    } catch (reason) {
      phase = 'error';
      error = `The episode could not be restored after the trailer: ${reason instanceof Error ? reason.message : String(reason)}`;
    } finally {
      mpvMediaOwner = 'episode';
      trailerOriginView = null;
      if (context.inlineAnchor?.isConnected) {
        context.inlineAnchor.style.visibility = context.inlineAnchorVisibility;
      }
      trailerInlineAnchor = null;
      trailerPlacement = null;

      if (activeView === 'player' && currentRef) {
        scheduleVideoViewportSync();
      } else if (isTauri() && mpvReady) {
        await runWithMpv(() =>
          setVideoMarginRatio({ left: 0, right: 0, top: 1, bottom: 0 }, MPV_WINDOW_LABEL)
        ).catch(() => undefined);
      }
    }
  }

  async function stopTrailerMedia(
    context: TrailerSessionContext,
    mediaWasReplaced: boolean
  ): Promise<void> {
    if (!isTauri() || !mpvReady) return;

    const failures: string[] = [];
    await runWithMpv(() =>
      setVideoMarginRatio({ left: 0, right: 0, top: 1, bottom: 0 }, MPV_WINDOW_LABEL)
    ).catch((reason) => failures.push(reason instanceof Error ? reason.message : String(reason)));
    if (mediaWasReplaced) {
      await runWithMpv(() => mpvCommand('stop', [], MPV_WINDOW_LABEL)).catch((reason) =>
        failures.push(reason instanceof Error ? reason.message : String(reason))
      );
    } else if (context.resume) {
      await runWithMpv(() => setProperty('pause', true, MPV_WINDOW_LABEL)).catch((reason) =>
        failures.push(reason instanceof Error ? reason.message : String(reason))
      );
    }
    if (!failures.length) return;

    try {
      await destroyMpv(MPV_WINDOW_LABEL);
      resetMpvClient();
      context.requiresEpisodeReload = Boolean(context.resume);
    } catch (reason) {
      throw new Error(
        `${failures.join(' ')} The mpv instance also could not be reset: ${reason instanceof Error ? reason.message : String(reason)}`
      );
    }
  }

  async function restoreEpisodeAfterTrailer(resume: TrailerResumeState): Promise<void> {
    const streamUrl = await callBackend<string>('stream_url', {
      id: resume.torrent.id,
      fileId: resume.torrent.fileId
    });
    const episodeUrl = `${streamUrl}/${encodeURIComponent(resume.torrent.video.name)}`;
    await loadMpvFileAndWait(episodeUrl, streamUrl);
    mpvMediaOwner = 'episode';
    const selectedAudio = resume.tracks.find((track) => track.type === 'audio' && track.selected);
    const selectedSubtitle = resume.tracks.find((track) => track.type === 'sub' && track.selected);
    playback = { ...resume.playback, paused: true };
    tracks = resume.tracks;
    await runWithMpv(async () => {
      if (resume.playback.time > 0) {
        await mpvCommand(
          'seek',
          [resume.playback.time, 'absolute+exact'],
          MPV_WINDOW_LABEL
        );
      }
      await setProperty('speed', resume.playback.speed, MPV_WINDOW_LABEL);
      await setProperty('volume', resume.playback.volume, MPV_WINDOW_LABEL);
      await setProperty('mute', resume.playback.muted, MPV_WINDOW_LABEL);
      await setProperty('aid', selectedAudio ? String(selectedAudio.id) : 'auto', MPV_WINDOW_LABEL);
      await setProperty('sid', selectedSubtitle ? String(selectedSubtitle.id) : 'no', MPV_WINDOW_LABEL);
      await setProperty('pause', true, MPV_WINDOW_LABEL);
    });
  }

  async function loadMpvFileAndWait(url: string, expectedPathPrefix: string): Promise<void> {
    const loadResult = waitForMpvFileLoad(expectedPathPrefix).then(
      () => ({ loaded: true as const }),
      (reason: Error) => ({ loaded: false as const, reason })
    );
    try {
      await runWithMpv(() =>
        mpvCommand('loadfile', [url, 'replace', -1, 'pause=yes'], MPV_WINDOW_LABEL)
      );
      const result = await loadResult;
      if (!result.loaded) throw result.reason;
    } catch (reason) {
      rejectMpvLoadWaiter(reason instanceof Error ? reason : new Error(String(reason)));
      await loadResult;
      throw reason;
    }
  }

  function waitForMpvFileLoad(expectedPathPrefix: string): Promise<void> {
    rejectMpvLoadWaiter(new Error('A newer media load replaced the previous request.'));
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (mpvLoadWaiter?.timer !== timer) return;
        mpvLoadWaiter = null;
        reject(new Error('mpv did not finish restoring the episode in time.'));
      }, MEDIA_LOAD_TIMEOUT_MS);
      mpvLoadWaiter = { expectedPathPrefix, resolve, reject, timer };
    });
  }

  async function confirmMpvLoadWaiter(): Promise<void> {
    const waiter = mpvLoadWaiter;
    if (!waiter) return;
    const path = await getProperty<string | null>('path', 'string', MPV_WINDOW_LABEL).catch(
      () => null
    );
    if (mpvLoadWaiter !== waiter || !path?.startsWith(waiter.expectedPathPrefix)) return;
    window.clearTimeout(waiter.timer);
    mpvLoadWaiter = null;
    waiter.resolve();
  }

  function rejectMpvLoadWaiter(reason: Error): void {
    const waiter = mpvLoadWaiter;
    if (!waiter) return;
    window.clearTimeout(waiter.timer);
    mpvLoadWaiter = null;
    waiter.reject(reason);
  }

  async function changeActiveView(nextView: AppView): Promise<void> {
    if (nextView === activeView) return;
    const generation = ++activeViewRequestGeneration;
    if (trailerPlayback) await closeTrailer();
    if (generation !== activeViewRequestGeneration || trailerController.active) return;
    activeView = nextView;
  }

  async function playTrailer(request: TrailerPlaybackRequest): Promise<void> {
    if (!isTauri()) return;
    await trailerController.start(request, playback.volume, playback.muted);
  }

  async function closeTrailer(): Promise<void> {
    await trailerController.close();
  }

  async function toggleTrailerPlayback(): Promise<void> {
    await trailerController.togglePlayback();
    revealPlayerUi();
  }

  async function pauseTrailerPlayback(): Promise<void> {
    await trailerController.pause();
  }

  async function seekTrailerRelative(seconds: number): Promise<void> {
    if (!trailerPlayback) return;
    await trailerController.seek(trailerPlayback.time + seconds);
  }

  async function seekTrailerAbsolute(percent: number): Promise<void> {
    if (!trailerPlayback?.duration) return;
    await trailerController.seek(
      (Math.max(0, Math.min(100, percent)) / 100) * trailerPlayback.duration
    );
  }

  async function changeTrailerVolume(volume: number): Promise<void> {
    await trailerController.changeVolume(volume);
  }

  async function toggleTrailerMute(): Promise<void> {
    await trailerController.toggleMute();
  }

  function onMpvProperty(event: MpvEventFromProperties<(typeof OBSERVED_PROPERTIES)[number]>) {
    if (mpvMediaOwner === 'transition') return;
    if (mpvMediaOwner === 'trailer') {
      if (event.name === 'path') {
        if (
          typeof event.data === 'string' &&
          event.data !== trailerOutgoingPath &&
          isSupportedTrailerUrl(event.data)
        ) {
          trailerLoadedPath = event.data;
          scheduleVideoViewportSync();
        }
      } else if (event.name !== 'track-list' && event.name !== 'speed') {
        trailerController.handleProperty(event.name, event.data);
      }
      return;
    }
    if (event.name === 'track-list') {
      tracks = normalizeTracks(event.data);
      return;
    }
    if (event.name === 'pause') playback = { ...playback, paused: Boolean(event.data) };
    else if (event.name === 'time-pos') {
      const time = Number(event.data ?? 0);
      playback = { ...playback, time };
      if (
        seekTarget !== null &&
        Math.abs(time - seekTarget) <= SEEK_RECONCILE_TOLERANCE_SECONDS
      ) {
        seekTarget = null;
      }
    } else if (event.name === 'duration') playback = { ...playback, duration: Number(event.data ?? 0) };
    else if (event.name === 'volume') playback = { ...playback, volume: Number(event.data ?? 0) };
    else if (event.name === 'mute') playback = { ...playback, muted: Boolean(event.data) };
    else if (event.name === 'speed') playback = { ...playback, speed: Number(event.data ?? 1) };
    else if (event.name === 'media-title') {
      playback = {
        ...playback,
        mediaTitle: typeof event.data === 'string' ? event.data : undefined
      };
    } else if (event.name === 'paused-for-cache') {
      if (!currentRef || !streamStarted) return;
      if (Boolean(event.data)) {
        mpvPausedForCache = true;
        if (phase !== 'buffering') bufferingStartedAt = Date.now();
        phase = 'buffering';
        armBufferingWatchdog();
      } else if (playback.duration > 0 || playback.time > 0) {
        mpvPausedForCache = false;
        markStreamReady();
      } else {
        mpvPausedForCache = false;
      }
    }

    if (event.name === 'duration' && Number(event.data) > 0 && !mpvPausedForCache) {
      markStreamReady();
    } else if (
      event.name === 'time-pos' &&
      typeof event.data === 'number' &&
      Number.isFinite(event.data) &&
      !mpvPausedForCache
    ) {
      markStreamReady();
    }
  }

  function clearBufferingWatchdog() {
    if (bufferingWatchdogTimer !== null) window.clearTimeout(bufferingWatchdogTimer);
    bufferingWatchdogTimer = null;
  }

  function armBufferingWatchdog(attempt = streamAttemptGeneration) {
    clearBufferingWatchdog();
    bufferingWatchdogTimer = window.setTimeout(() => {
      bufferingWatchdogTimer = null;
      if (attempt !== streamAttemptGeneration || phase !== 'buffering' || !streamStarted) return;
      handleStreamFailure('mpv kept waiting for video data from the local torrent stream.', attempt);
    }, PLAYBACK_START_TIMEOUT_MS);
  }

  function markStreamReady() {
    if (!currentRef || !streamStarted) return;
    clearBufferingWatchdog();
    mpvPausedForCache = false;
    streamFailures = 0;
    nextStreamRetryAt = 0;
    error = '';
    phase = 'ready';
  }

  function onMpvEvent(event: MpvEvent): void {
    if (event.event === 'file-loaded') {
      void confirmMpvLoadWaiter();
    } else if (event.event === 'end-file' && event.reason === 'error') {
      rejectMpvLoadWaiter(new Error('mpv could not load the requested media.'));
    }

    if (mpvMediaOwner === 'transition') return;
    if (mpvMediaOwner === 'trailer') {
      if (event.event === 'video-reconfig') scheduleVideoViewportSync();
      trailerController.handleEvent(event);
      return;
    }
    if (event.event === 'start-file') {
      mpvPausedForCache = true;
      bufferingStartedAt = Date.now();
      phase = 'buffering';
      armBufferingWatchdog();
    }
    if (event.event === 'playback-restart') {
      markStreamReady();
    }
    if (event.event === 'end-file' && event.reason === 'error') {
      handleStreamFailure('mpv could not open the local torrent stream yet.');
    }
  }

  async function ensureMpv() {
    if (!isTauri()) return;
    if (mpvInitPromise) return mpvInitPromise;
    if (mpvReady) return;

    mpvInitPromise = (async () => {
      await initMpv(
        {
          initialOptions: {
            vo: 'gpu-next',
            hwdec: 'auto-safe',
            'keep-open': 'yes',
            idle: 'yes',
            'force-window': 'yes',
            osc: 'no',
            'input-default-bindings': 'no',
            ytdl: 'yes',
            'ytdl-format': 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
            'ytdl-raw-options': 'sub-langs=none',
            cache: 'yes',
            'cache-pause': 'yes',
            'cache-pause-initial': 'yes',
            'cache-pause-wait': 3,
            'cache-secs': 180,
            'demuxer-max-bytes': '512MiB',
            'demuxer-max-back-bytes': '192MiB',
            'demuxer-readahead-secs': 180,
            'demuxer-seekable-cache': 'yes',
            'demuxer-cache-wait': 'yes',
            'sub-auto': 'all',
            slang: preferredSubtitleLanguages(),
            alang: 'jpn,eng,nld'
          },
          observedProperties: OBSERVED_PROPERTIES
        },
        MPV_WINDOW_LABEL
      );
      mpvUnlisten?.();
      mpvEventUnlisten?.();
      mpvUnlisten = await observeProperties(
        OBSERVED_PROPERTIES,
        onMpvProperty,
        MPV_WINDOW_LABEL
      );
      mpvEventUnlisten = await listenEvents(onMpvEvent, MPV_WINDOW_LABEL);

      const margins =
        mpvMediaOwner === 'transition'
          ? { left: 0, right: 0, top: 1, bottom: 0 }
          : currentVideoMargins();
      if (margins) await setVideoMarginRatio(margins, MPV_WINDOW_LABEL);
      mpvReady = true;
    })();

    try {
      await mpvInitPromise;
    } catch (reason) {
      resetMpvClient();
      throw reason;
    } finally {
      mpvInitPromise = null;
    }
  }

  function openTorrentStream(target: CurrentTorrent, attempt: number): Promise<void> {
    return trackEpisodeMediaOperation(performOpenTorrentStream(target, attempt));
  }

  async function performOpenTorrentStream(target: CurrentTorrent, attempt: number) {
    if (attempt !== streamAttemptGeneration || mpvMediaOwner !== 'episode') return;
    const streamUrl = await callBackend<string>('stream_url', {
      id: target.id,
      fileId: target.fileId
    });
    const url = `${streamUrl}/${encodeURIComponent(target.video.name)}`;
    if (attempt !== streamAttemptGeneration || mpvMediaOwner !== 'episode') return;
    await runWithMpv(async () => {
      if (attempt !== streamAttemptGeneration || mpvMediaOwner !== 'episode') return;
      const margins = currentVideoMargins();
      if (margins) await setVideoMarginRatio(margins, MPV_WINDOW_LABEL);
      if (attempt !== streamAttemptGeneration || mpvMediaOwner !== 'episode') return;
      await mpvCommand('loadfile', [url, 'replace'], MPV_WINDOW_LABEL);
      await setProperty('pause', false, MPV_WINDOW_LABEL);
    });
    if (attempt !== streamAttemptGeneration || mpvMediaOwner !== 'episode') return;
    await waitForPlaybackStart(streamUrl, attempt);
  }

  async function waitForPlaybackStart(streamUrl: string, attempt: number) {
    const deadline = Date.now() + PLAYBACK_START_TIMEOUT_MS;
    let verifiedPath = false;
    while (
      attempt === streamAttemptGeneration &&
      mpvMediaOwner === 'episode' &&
      Date.now() < deadline
    ) {
      if (phase === 'ready') return;
      if (!verifiedPath) {
        const pathResult = await getProperty<string | null>('path', 'string', MPV_WINDOW_LABEL).catch(
          () => null
        );
        verifiedPath = typeof pathResult === 'string' && pathResult.startsWith(streamUrl);
      }
      const pausedForCache = await getProperty<boolean>('paused-for-cache', 'flag', MPV_WINDOW_LABEL).catch(
        () => true
      );
      const time = await getProperty<number | null>('time-pos', 'double', MPV_WINDOW_LABEL).catch(
        () => null
      );
      if (attempt !== streamAttemptGeneration || mpvMediaOwner !== 'episode') return;
      if (
        verifiedPath &&
        pausedForCache === false &&
        typeof time === 'number' &&
        Number.isFinite(time)
      ) {
        markStreamReady();
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, PLAYBACK_PROBE_INTERVAL_MS));
    }
    if (attempt !== streamAttemptGeneration || mpvMediaOwner !== 'episode') return;
    const peers = statsRef?.live?.snapshot.peer_stats.live ?? 0;
    throw new Error(
      peers === 0
        ? 'There are no reachable peers for this torrent yet.'
        : 'mpv did not receive a playable video segment in time.'
    );
  }

  function handleStreamFailure(message: string, attempt = streamAttemptGeneration) {
    if (!currentRef) return;
    if (attempt !== streamAttemptGeneration) return;
    clearBufferingWatchdog();
    mpvPausedForCache = false;
    streamAttemptGeneration += 1;
    streamStarted = false;
    streamFailures += 1;
    if (streamFailures >= MAX_STREAM_FAILURES) {
      nextStreamRetryAt = Number.POSITIVE_INFINITY;
      phase = 'error';
      error = `${message} The local stream was attempted ${MAX_STREAM_FAILURES} times.`;
      return;
    }
    nextStreamRetryAt = Date.now() + STREAM_RETRY_DELAY_MS;
    bufferingStartedAt = Date.now();
    error = '';
    phase = 'buffering';
  }

  async function clearCurrentForReplacement() {
    const previous = currentRef;
    if (!previous) return;
    if (isTauri()) {
      if (mpvReady) {
        await runWithMpv(() => mpvCommand('stop', [], MPV_WINDOW_LABEL));
      }
      await callBackend<void>('forget_torrent', { id: previous.id });
    }
    currentRef = null;
    statsRef = null;
    clearBufferingWatchdog();
    mpvPausedForCache = false;
    streamAttemptGeneration += 1;
    streamStarted = false;
    streamFailures = 0;
    pendingSeekTime = null;
    seekGeneration += 1;
    current = null;
    playingEpisode = null;
    stats = null;
    tracks = [];
    seekTarget = null;
  }

  async function startTorrent(releaseMagnet: string): Promise<boolean> {
    error = '';
    const magnetToOpen = releaseMagnet.trim();
    if (!magnetToOpen.startsWith('magnet:?')) {
      error = 'Enter a valid magnet link.';
      phase = 'error';
      return false;
    }
    if (isTauri() && runtime && !runtime.mpvAvailable) {
      error = 'The bundled libmpv runtime is missing. Reinstall StreamsPlease or run the libmpv setup step.';
      phase = 'error';
      return false;
    }

    phase = 'connecting';
    try {
      await clearCurrentForReplacement();
      const response = await callBackend<AddTorrentResponse>('add_magnet', { magnet: magnetToOpen });
      if (response.id === undefined) throw new Error('The torrent engine did not return a session ID.');
      const videoCandidates = (response.details.files ?? [])
        .map((file, fileId) => ({ file, fileId }))
        .filter(({ file }) =>
          VIDEO_EXTENSIONS.some((extension) => file.name.toLowerCase().endsWith(extension))
        )
        .sort((left, right) => right.file.length - left.file.length);
      const chosen = videoCandidates[0];
      if (!chosen) throw new Error('This torrent does not contain a supported video file.');

      const nextCurrent: CurrentTorrent = {
        id: response.id,
        details: response.details,
        video: chosen.file,
        fileId: chosen.fileId
      };
      currentRef = nextCurrent;
      statsRef = null;
      streamStarted = false;
      streamFailures = 0;
      clearBufferingWatchdog();
      mpvPausedForCache = false;
      streamAttemptGeneration += 1;
      nextStreamRetryAt = 0;
      stats = null;
      current = nextCurrent;
      bufferingStartedAt = Date.now();
      phase = 'buffering';
      playback = { ...playback, paused: false, time: 0, duration: 0 };

      if (isTauri()) {
        await ensureMpv();
      } else {
        tracks = [
          { id: 1, type: 'video', codec: 'h264', selected: true },
          { id: 2, type: 'audio', lang: 'jpn', title: 'Japanese', codec: 'aac', selected: true },
          { id: 3, type: 'audio', lang: 'eng', title: 'English', codec: 'aac' },
          { id: 4, type: 'sub', lang: 'eng', title: 'English • ASS', codec: 'ass', selected: true },
          { id: 5, type: 'sub', lang: 'nld', title: 'Dutch', codec: 'ass' }
        ];
        playback = { ...playback, duration: 888, paused: false };
        phase = 'ready';
      }
      return true;
    } catch (reason) {
      phase = 'error';
      error = reason instanceof Error ? reason.message : String(reason);
      return false;
    }
  }

  function commitLibrary(entries: LibraryEntry[]) {
    libraryEntries = entries;
    saveLibrary(entries);
  }

  function updatePreferredQuality(quality: PlaybackQuality) {
    preferredQuality = quality;
    saveSettings({ preferredQuality: quality, preferredSubtitleLanguage });
  }

  function updatePreferredSubtitleLanguage(language: SubtitleLanguage) {
    preferredSubtitleLanguage = language;
    saveSettings({ preferredQuality, preferredSubtitleLanguage: language });
    if (isTauri() && mpvReady) {
      void runWithMpv(() =>
        setProperty('slang', preferredSubtitleLanguages(), MPV_WINDOW_LABEL)
      ).catch(() => undefined);
    }
  }

  function posterUrl(path: string): string {
    if (!path) return '';
    return path.startsWith('http')
      ? path
      : `https://subsplease.org${path.startsWith('/') ? '' : '/'}${path}`;
  }

  function syncLibraryShow(
    details: SubsPleaseShowResponse,
    show: SubsPleaseScheduleShow,
    day?: DayName
  ) {
    const anilistId = details.metadata_id ?? show.anilist_id;
    const slug = details.slug || show.page;
    const index = libraryEntries.findIndex((entry) =>
      libraryEntryMatches(entry, anilistId, slug)
    );
    if (index < 0) return;
    const next = [...libraryEntries];
    next[index] = entryFromShow(details, show, day, next[index]);
    commitLibrary(next);
  }

  function toggleLibraryShow(
    details: SubsPleaseShowResponse,
    show: SubsPleaseScheduleShow,
    day?: DayName
  ) {
    const anilistId = details.metadata_id ?? show.anilist_id;
    const slug = details.slug || show.page;
    const existing = libraryEntries.find((entry) =>
      libraryEntryMatches(entry, anilistId, slug)
    );
    if (existing) {
      if (existing.following) {
        if (existing.discoveryVerdict) {
          commitLibrary(
            libraryEntries.map((entry) =>
              libraryEntryMatches(entry, anilistId, slug)
                ? {
                    ...entry,
                    following: false,
                    libraryDismissed: true,
                    updatedAt: new Date().toISOString()
                  }
                : entry
            )
          );
        } else {
          commitLibrary(
            libraryEntries.filter((entry) => !libraryEntryMatches(entry, anilistId, slug))
          );
        }
      } else {
        commitLibrary(
          libraryEntries.map((entry) =>
            libraryEntryMatches(entry, anilistId, slug)
              ? {
                  ...entryFromShow(details, show, day, entry),
                  following: true,
                  libraryDismissed: false
                }
              : entry
          )
        );
      }
      return;
    }
    commitLibrary([...libraryEntries, entryFromShow(details, show, day)]);
  }

  function setDiscoveryVerdict(
    details: SubsPleaseShowResponse,
    show: SubsPleaseScheduleShow,
    day: DayName | undefined,
    verdict?: DiscoveryVerdict
  ) {
    const anilistId = details.metadata_id ?? show.anilist_id;
    const slug = details.slug || show.page;
    const index = libraryEntries.findIndex((entry) =>
      libraryEntryMatches(entry, anilistId, slug)
    );
    if (!verdict) {
      if (index < 0) return;
      const existing = libraryEntries[index];
      if (!existing.following) {
        commitLibrary(libraryEntries.filter((_, entryIndex) => entryIndex !== index));
        return;
      }
      const next = [...libraryEntries];
      next[index] = {
        ...existing,
        discoveryVerdict: undefined,
        checkedAt: undefined,
        updatedAt: new Date().toISOString()
      };
      commitLibrary(next);
      return;
    }
    if (index < 0) {
      commitLibrary([
        ...libraryEntries,
        entryFromDiscovery(details, show, verdict, day)
      ]);
      return;
    }
    const next = [...libraryEntries];
    next[index] = entryFromDiscovery(details, show, verdict, day, next[index]);
    commitLibrary(next);
  }

  function decideDiscoveryShow(
    details: SubsPleaseShowResponse,
    show: SubsPleaseScheduleShow,
    day: DayName | undefined,
    verdict: DiscoveryVerdict
  ) {
    setDiscoveryVerdict(details, show, day, verdict);
  }

  function setEpisodeWatched(slug: string, episode: string, watched: boolean) {
    const index = libraryEntries.findIndex((entry) => entry.slug === slug);
    if (index < 0) return;
    const entry = libraryEntries[index];
    const watchedEpisodes = watched
      ? [...new Set([...entry.watchedEpisodes, episode])]
      : entry.watchedEpisodes.filter((value) => value !== episode);
    const next = [...libraryEntries];
    next[index] = { ...entry, watchedEpisodes, updatedAt: new Date().toISOString() };
    commitLibrary(next);
  }

  function toggleEpisodeWatched(slug: string, episode: string) {
    const entry = libraryEntries.find((item) => item.slug === slug);
    if (!entry) return;
    setEpisodeWatched(slug, episode, !entry.watchedEpisodes.includes(episode));
  }

  function setEpisodeProgress(slug: string, progressCount: number) {
    const index = libraryEntries.findIndex((entry) => entry.slug === slug);
    if (index < 0) return;
    const entry = libraryEntries[index];
    const count = Math.min(
      Math.max(Math.round(progressCount), 0),
      entry.availableEpisodes.length
    );
    const watchedEpisodes = sortEpisodeNumbers(entry.availableEpisodes).slice(0, count);
    const next = [...libraryEntries];
    next[index] = { ...entry, watchedEpisodes, updatedAt: new Date().toISOString() };
    commitLibrary(next);
  }

  async function playSubsPleaseRelease(request: EpisodePlaybackRequest) {
    await changeActiveView('player');
    if (activeView !== 'player') return;
    queueOpen = false;
    playingEpisode = null;
    autoMarkedPlaybackKey = '';
    const started = await startTorrent(request.magnet);
    if (started) playingEpisode = request;
  }

  function returnToShowDetails() {
    if (!playingEpisode) return;
    requestedShowSlug = playingEpisode.slug;
    theaterMode = false;
    activeView = libraryEntries.some(
      (entry) =>
        entry.following &&
        libraryEntryMatches(entry, playingEpisode?.anilistId, playingEpisode?.slug)
    )
      ? 'library'
      : 'subsplease';
    window.setTimeout(() => void syncVideoViewport(), 120);
  }

  function consumeShowRequest() {
    requestedShowSlug = '';
  }

  function loadSubsPleaseSchedule(timezone: string) {
    return callBackend<SubsPleaseScheduleResponse>('subsplease_schedule', { timezone });
  }

  function loadSubsPleaseIndex() {
    if (!subspleaseIndexRequest) {
      const cached = loadCachedProviderIndex(PROVIDER_INDEX_CACHE_MAX_AGE_MS);
      subspleaseIndexRequest = cached
        ? Promise.resolve(cached)
        : callBackend<SubsPleaseIndexResponse>('subsplease_index')
            .then((response) => {
              saveCachedProviderIndex(response);
              return response;
            })
            .catch((reason) => {
              subspleaseIndexRequest = null;
              throw reason;
            });
    }
    return subspleaseIndexRequest;
  }

  function seasonCacheMaxAge(season: AnimeSeason, year: number): number {
    const current = currentSeason();
    const requestedIndex = year * 4 + SEASON_ORDER.indexOf(season);
    const currentIndex = current.year * 4 + SEASON_ORDER.indexOf(current.season);
    if (requestedIndex === currentIndex) return CURRENT_SEASON_CACHE_MAX_AGE_MS;
    return requestedIndex < currentIndex
      ? PAST_SEASON_CACHE_MAX_AGE_MS
      : FUTURE_SEASON_CACHE_MAX_AGE_MS;
  }

  function loadAniListSeason(season: AnimeSeason, year: number) {
    const key = `${season}:${year}`;
    let request = seasonCatalogRequests.get(key);
    if (!request) {
      const cached = loadCachedSeason(season, year, seasonCacheMaxAge(season, year));
      request = cached
        ? Promise.resolve(cached)
        : callBackend<AniListSeasonResponse>('anilist_season', { season, year })
            .then((response) => {
              saveCachedSeason(response);
              return response;
            })
            .catch((reason) => {
              seasonCatalogRequests.delete(key);
              throw reason;
            });
      seasonCatalogRequests.set(key, request);
    }
    return request;
  }

  function loadSubsPleaseShow(slug: string, timezone: string, anilistId?: number) {
    return callBackend<SubsPleaseShowResponse>('subsplease_show', {
      slug,
      timezone,
      anilistId
    });
  }

  async function togglePlayback() {
    if (!current) return;
    const paused = !playback.paused;
    if (isTauri()) {
      await runWithMpv(() => setProperty('pause', paused, MPV_WINDOW_LABEL));
    }
    playback = { ...playback, paused };
  }

  async function pausePlayback() {
    if (!current || playback.paused) return;
    playback = { ...playback, paused: true };
    if (isTauri()) {
      await runWithMpv(() => setProperty('pause', true, MPV_WINDOW_LABEL)).catch(() => undefined);
    }
  }

  function revealPlayerUi() {
    playerUiVisible = true;
    if (playerUiTimer !== null) window.clearTimeout(playerUiTimer);
    playerUiTimer = window.setTimeout(() => {
      playerUiTimer = null;
      if (trailerPlayback || (activeView === 'player' && current && !queueOpen)) {
        playerUiVisible = false;
      }
    }, 5_000);
  }

  function toggleTheater(force?: boolean) {
    theaterMode = force ?? !theaterMode;
    revealPlayerUi();
    scheduleVideoViewportSync();
  }

  function togglePlayingEpisodeWatched(watched: boolean) {
    if (!playingEpisode || !playingLibraryEntry || watched === playingEpisodeWatched) return;
    setEpisodeWatched(playingEpisode.slug, playingEpisode.episode, watched);
  }

  function scheduleSeek(time: number) {
    if (!current || playback.duration <= 0) return;
    const target = Math.max(0, Math.min(playback.duration, time));
    pendingSeekTime = target;
    seekTarget = target;

    if (!isTauri()) {
      pendingSeekTime = null;
      playback = { ...playback, time: target };
      seekTarget = null;
      return;
    }

    flushScheduledSeek();
  }

  function seekRelative(seconds: number) {
    if (!current) return;
    scheduleSeek((pendingSeekTime ?? seekTarget ?? playback.time) + seconds);
  }

  function seekAbsolute(percent: number) {
    if (!current) return;
    scheduleSeek((Math.max(0, Math.min(100, percent)) / 100) * playback.duration);
  }

  function flushScheduledSeek() {
    if (seekOperation || pendingSeekTime === null) return;
    const generation = seekGeneration;
    const operation = trackEpisodeMediaOperation(performScheduledSeek(generation));
    seekOperation = operation;
    operation.then(
      () => finishScheduledSeek(operation, generation),
      () => finishScheduledSeek(operation, generation)
    );
  }

  function finishScheduledSeek(operation: Promise<void>, generation: number) {
    if (seekOperation !== operation) return;
    seekOperation = null;
    if (generation === seekGeneration && pendingSeekTime !== null) flushScheduledSeek();
  }

  async function performScheduledSeek(generation: number) {
    while (
      generation === seekGeneration &&
      current &&
      mpvMediaOwner === 'episode' &&
      pendingSeekTime !== null
    ) {
      const target = pendingSeekTime;
      pendingSeekTime = null;
      try {
        await runWithMpv(() =>
          mpvCommand('seek', [target, 'absolute+exact'], MPV_WINDOW_LABEL).then(() => undefined)
        );
      } catch (reason) {
        if (generation === seekGeneration && seekTarget === target) {
          seekTarget = null;
          error = `Seek could not be completed: ${reason instanceof Error ? reason.message : String(reason)}`;
        }
        return;
      }
    }
  }

  async function changeVolume(volume: number) {
    playback = { ...playback, volume, muted: false };
    if (isTauri()) {
      await runWithMpv(() => setProperty('mute', false, MPV_WINDOW_LABEL));
      await runWithMpv(() => setProperty('volume', volume, MPV_WINDOW_LABEL));
    }
  }

  async function toggleMute() {
    const muted = !playback.muted;
    playback = { ...playback, muted };
    if (isTauri()) {
      await runWithMpv(() => setProperty('mute', muted, MPV_WINDOW_LABEL));
    }
  }

  async function cycleSpeed() {
    const speeds = [1, 1.25, 1.5, 2, 0.75];
    const next = speeds[(speeds.indexOf(playback.speed) + 1) % speeds.length];
    playback = { ...playback, speed: next };
    if (isTauri()) {
      await runWithMpv(() => setProperty('speed', next, MPV_WINDOW_LABEL));
    }
  }

  async function toggleFullscreen(force?: boolean) {
    if (!isTauri()) return;
    const appWindow = getCurrentWindow();
    const nextFullscreenMode = force ?? !(await appWindow.isFullscreen());
    await appWindow.setFullscreen(nextFullscreenMode);
    fullscreenMode = nextFullscreenMode;
    revealPlayerUi();
    scheduleVideoViewportSync();
  }

  async function selectTrack(type: 'sid' | 'aid', value: string) {
    const previousTracks = tracks;
    const numericId = value === 'no' ? undefined : Number(value);
    tracks = tracks.map((track) => {
      const matchesType = type === 'sid' ? track.type === 'sub' : track.type === 'audio';
      return matchesType ? { ...track, selected: track.id === numericId } : track;
    });
    if (!isTauri()) return;

    try {
      await runWithMpv(() => setProperty(type, value, MPV_WINDOW_LABEL));
    } catch (reason) {
      tracks = previousTracks;
      error = `The track could not be changed: ${reason instanceof Error ? reason.message : String(reason)}`;
    }
  }

  async function retryPlayback() {
    if (!current || trailerPlayback || mpvMediaOwner !== 'episode') return;
    error = '';
    bufferingStartedAt = Date.now();
    clearBufferingWatchdog();
    mpvPausedForCache = false;
    streamAttemptGeneration += 1;
    streamStarted = false;
    streamFailures = 0;
    nextStreamRetryAt = 0;
    phase = 'buffering';
    if (isTauri()) {
      const selectedFileProgress = statsRef?.file_progress?.[current.fileId] ?? statsRef?.progress_bytes ?? 0;
      const enoughBuffered =
        statsRef?.finished || selectedFileProgress >= MIN_STREAM_START_BYTES;
      if (enoughBuffered) {
        streamStarted = true;
        try {
          const attempt = ++streamAttemptGeneration;
          await openTorrentStream(current, attempt);
        } catch (reason) {
          handleStreamFailure(reason instanceof Error ? reason.message : String(reason));
        }
      }
    }
  }

</script>

<div class="grid h-screen min-h-0 overflow-hidden text-(--text) {immersiveMode ? 'grid-rows-[minmax(0,1fr)]' : 'grid-rows-[4rem_minmax(0,1fr)]'}">
  {#if !immersiveMode}
  <header class="flex items-stretch gap-4 border-b border-(--text)/8 bg-(--bg) px-4" data-tauri-drag-region>
    <div class="flex min-w-0 shrink-0 items-center px-2" data-tauri-drag-region>
      <StreamsPleaseLogo />
    </div>

    <Tabs
      value={activeView}
      onValueChange={(value) => void changeActiveView(value as AppView)}
      class="h-full min-w-0"
    >
      <TabsList class="h-full gap-0 rounded-none bg-transparent p-0">
        <TabsTrigger value="player" class="h-full gap-2 rounded-none border-b-2 border-transparent px-5 py-0 shadow-none data-[state=active]:border-(--text) data-[state=active]:bg-(--text)/4 data-[state=active]:shadow-none"><MonitorPlay class="size-4" /> Player</TabsTrigger>
        <TabsTrigger value="library" class="h-full gap-2 rounded-none border-b-2 border-transparent px-5 py-0 shadow-none data-[state=active]:border-(--text) data-[state=active]:bg-(--text)/4 data-[state=active]:shadow-none"><BookOpen class="size-4" /> Library</TabsTrigger>
        <TabsTrigger value="discovery" class="h-full gap-2 rounded-none border-b-2 border-transparent px-5 py-0 shadow-none data-[state=active]:border-(--text) data-[state=active]:bg-(--text)/4 data-[state=active]:shadow-none"><Sparkles class="size-4" /> Discovery</TabsTrigger>
        <TabsTrigger value="subsplease" class="h-full gap-2 rounded-none border-b-2 border-transparent px-5 py-0 shadow-none data-[state=active]:border-(--text) data-[state=active]:bg-(--text)/4 data-[state=active]:shadow-none"><CalendarDays class="size-4" /> SubsPlease</TabsTrigger>
      </TabsList>
    </Tabs>

    <div class="min-w-4 flex-1" data-tauri-drag-region></div>
    <Button
      variant="ghost"
      size="icon"
      class={`my-auto shrink-0 ${activeView === 'account' ? 'bg-(--text)/10 text-(--text)' : ''}`}
      aria-label="Account settings"
      aria-current={activeView === 'account' ? 'page' : undefined}
      onclick={() => void changeActiveView('account')}
    ><CircleUserRound class="size-5" /></Button>
  </header>
  {/if}

  <div bind:this={contentViewport} class="relative min-h-0 overflow-hidden">
  {#if activeView === 'discovery'}
    {#if trailerInlineMode && trailerPlacement}
      <span class="pointer-events-none absolute inset-x-0 top-0 z-0 bg-(--bg)" style={`height:${Math.max(0, trailerPlacement.top)}px`} aria-hidden="true"></span>
      <span class="pointer-events-none absolute inset-x-0 bottom-0 z-0 bg-(--bg)" style={`top:${Math.max(0, trailerPlacement.top + trailerPlacement.height)}px`} aria-hidden="true"></span>
      <span class="pointer-events-none absolute left-0 z-0 bg-(--bg)" style={`top:${trailerPlacement.top}px;width:${Math.max(0, trailerPlacement.left)}px;height:${trailerPlacement.height}px`} aria-hidden="true"></span>
      <span class="pointer-events-none absolute right-0 z-0 bg-(--bg)" style={`left:${Math.max(0, trailerPlacement.left + trailerPlacement.width)}px;top:${trailerPlacement.top}px;height:${trailerPlacement.height}px`} aria-hidden="true"></span>
    {:else if !trailerPlayback}
      <span class="pointer-events-none absolute inset-0 z-0 bg-(--bg)" aria-hidden="true"></span>
    {/if}
  {/if}
  <div class="relative z-10 h-full min-h-0 {trailerPlayback && !trailerInlineMode ? 'invisible pointer-events-none' : ''}">
  {#if activeView === 'library'}
    <LibraryPage
      entries={libraryEntries}
      loadIndex={loadSubsPleaseIndex}
      loadShow={loadSubsPleaseShow}
      onPlay={playSubsPleaseRelease}
      onPlayTrailer={playTrailer}
      onBrowse={() => void changeActiveView('discovery')}
      onToggleLibrary={toggleLibraryShow}
      onSetDiscoveryVerdict={setDiscoveryVerdict}
      onToggleWatched={toggleEpisodeWatched}
      onSetProgress={setEpisodeProgress}
      onShowLoaded={syncLibraryShow}
      {preferredQuality}
      openSlug={requestedShowSlug}
      onOpenConsumed={consumeShowRequest}
    />
  {:else if activeView === 'discovery'}
    <DiscoveryPage
      loadSeason={loadAniListSeason}
      loadIndex={loadSubsPleaseIndex}
      loadSchedule={loadSubsPleaseSchedule}
      loadShow={loadSubsPleaseShow}
      libraryEntries={libraryEntries}
      onDecide={decideDiscoveryShow}
      onOpenLibrary={() => void changeActiveView('library')}
      onPlayTrailer={playTrailer}
      onCloseTrailer={closeTrailer}
    />
  {:else if activeView === 'subsplease'}
    <SubsPleasePage
      loadSeason={loadAniListSeason}
      loadIndex={loadSubsPleaseIndex}
      loadSchedule={loadSubsPleaseSchedule}
      loadShow={loadSubsPleaseShow}
      onPlay={playSubsPleaseRelease}
      onPlayTrailer={playTrailer}
      libraryEntries={libraryEntries}
      onToggleLibrary={toggleLibraryShow}
      onSetDiscoveryVerdict={setDiscoveryVerdict}
      onToggleWatched={toggleEpisodeWatched}
      onShowLoaded={syncLibraryShow}
      {preferredQuality}
      openSlug={requestedShowSlug}
      onOpenConsumed={consumeShowRequest}
    />
  {:else if activeView === 'account'}
    <AccountSettingsPage
      {preferredQuality}
      {preferredSubtitleLanguage}
      onQualityChange={updatePreferredQuality}
      onSubtitleLanguageChange={updatePreferredSubtitleLanguage}
    />
  {:else}
    <main class="h-full min-h-0 {current && phase !== 'error' && isTauri() ? 'bg-transparent' : 'bg-black'}">
        <section
          bind:this={videoViewport}
          class="video-surface relative h-full min-h-0 overflow-hidden {current && phase !== 'error' ? 'live' : ''}"
          class:cursor-none={current && !playerUiVisible}
          aria-label="Video player"
          onpointermove={revealPlayerUi}
          onpointerdown={revealPlayerUi}
        >
          {#if !current && phase === 'idle'}
            <div class="grid size-full place-items-center px-6 text-center text-white/42">
              <div>
                <MonitorPlay class="mx-auto mb-4 size-9 stroke-[1.4]" />
                <p class="text-sm font-medium tracking-[-0.01em] text-white/62">Select an episode from SubsPlease first.</p>
              </div>
            </div>
          {:else if phase === 'connecting'}
            <div class="grid size-full place-items-center text-white" role="status" aria-live="polite">
              <div class="flex flex-col items-center text-center">
                <Spinner class="size-11 border-[3px] border-white/15 border-t-white" />
                <h2 class="mt-5 text-base font-medium tracking-[-0.01em]">Connecting</h2>
                <p class="mt-1.5 text-xs text-white/48">Finding seeders for this episode</p>
                <div class="mt-5 flex items-center gap-3 text-[10px] font-medium uppercase tracking-[0.14em] text-white/34">
                  <span>Seeders</span>
                  <strong class="font-medium text-white/65">Searching</strong>
                  <span class="h-3 w-px bg-white/14" aria-hidden="true"></span>
                  <span>Download</span>
                  <strong class="font-medium normal-case tracking-normal text-white/65">—</strong>
                </div>
              </div>
            </div>
          {:else if !current && phase === 'error'}
            <div class="grid size-full place-items-center p-6">
              <Alert variant="destructive" class="max-w-md"><AlertCircle class="size-5" /><AlertTitle>Episode could not start</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>
            </div>
          {/if}

          {#if current && phase === 'buffering'}
            <div class="pointer-events-none absolute inset-0 z-30 grid place-items-center text-white" role="status" aria-live="polite">
              <div class="flex flex-col items-center text-center">
                <Spinner class="size-11 border-[3px] border-white/15 border-t-white" />
                <h2 class="mt-5 text-base font-medium tracking-[-0.01em]">Buffering</h2>
                <p class="mt-1.5 text-xs text-white/48">
                  {waitingForPeers ? 'Waiting for the first video pieces' : 'Preparing smooth playback'}
                </p>
                <div class="mt-5 flex items-center gap-3 text-[10px] font-medium uppercase tracking-[0.14em] text-white/34">
                  <span>Seeders</span>
                  <strong class="font-medium tabular-nums text-white/65">{livePeers || '—'}</strong>
                  <span class="h-3 w-px bg-white/14" aria-hidden="true"></span>
                  <span>Download</span>
                  <strong class="font-medium normal-case tracking-normal tabular-nums text-white/65">{downloadSpeedLabel}</strong>
                </div>
                {#if waitingForPeers}
                  <Button variant="ghost" size="sm" class="pointer-events-auto mt-4 text-white/70 hover:bg-white/10 hover:text-white" onclick={() => void retryPlayback()}>Retry connection</Button>
                {/if}
              </div>
            </div>
          {/if}

          {#if current && phase === 'error'}
            <div class="grid size-full place-items-center p-6">
              <Alert variant="destructive" class="max-w-md"><AlertCircle class="size-5" /><AlertTitle>Stream could not start</AlertTitle><AlertDescription>{error}</AlertDescription><Button variant="ghost" size="sm" class="mt-3" onclick={() => void retryPlayback()}>Try again</Button></Alert>
            </div>
          {/if}

          {#if current}
            <Button variant="ghost" class="absolute inset-0 z-0 h-auto w-full rounded-none bg-transparent hover:bg-transparent" aria-label={playback.paused ? 'Play' : 'Pause'} onclick={() => void togglePlayback()}></Button>
            {#if playback.paused && phase === 'ready'}
              <Button size="icon" class="absolute left-1/2 top-1/2 z-10 size-16 -translate-x-1/2 -translate-y-1/2 shadow-xl transition-opacity duration-300 {playerUiVisible ? 'opacity-100' : 'pointer-events-none opacity-0'}" aria-label="Play" onclick={() => void togglePlayback()}><Play class="size-7" fill="currentColor" /></Button>
            {/if}
            <div class="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start gap-4 bg-gradient-to-b from-black/78 to-transparent p-5 text-white transition-opacity duration-300 {playerUiVisible ? 'opacity-100' : 'opacity-0'}">
              {#if playingEpisode}
                {@const playingVerdict = libraryEntries.find((entry) => libraryEntryMatches(entry, playingEpisode?.anilistId, playingEpisode?.slug))?.discoveryVerdict}
                <div class="pointer-events-auto flex min-w-0 items-start gap-3 rounded-2xl p-1 pr-3">
                  <button type="button" class="relative h-14 w-10 shrink-0 overflow-hidden rounded-lg bg-white/10 text-left hover:ring-2 hover:ring-white/25" aria-label={`Back to the details page for ${playingEpisode.title}`} onclick={returnToShowDetails}>
                    {#if playingEpisode.imageUrl}<RevealImage class="size-full object-cover" src={posterUrl(playingEpisode.imageUrl)} alt="" />{/if}
                    <TasteIndicator verdict={playingVerdict} decorative class="absolute bottom-1 right-1 size-5 [&_svg]:size-3" />
                  </button>
                  <div class="min-w-0 pt-0.5">
                    <button type="button" class="block min-w-0 text-left" aria-label={`Back to the details page for ${playingEpisode.title}`} onclick={returnToShowDetails}>
                      <span class="block text-[9px] font-medium uppercase tracking-[0.16em] text-white/48">Back to show</span>
                      <strong class="mt-0.5 block max-w-sm truncate text-sm font-medium">{playingEpisode.title}</strong>
                    </button>
                    <div class="mt-1.5 flex items-center gap-3">
                      <small class="text-[10px] text-white/55">Episode {playingEpisode.episode}</small>
                      {#if playingLibraryEntry}
                        <label class="inline-flex items-center gap-1.5 text-[10px] font-medium text-white/72">
                          <Switch
                            class="h-5 w-9 [&_[data-slot=switch-thumb]]:size-4 [&_[data-slot=switch-thumb]][data-state=checked]:translate-x-4"
                            checked={playingEpisodeWatched}
                            aria-label={playingEpisodeWatched ? 'Mark as unwatched' : 'Mark as watched'}
                            onCheckedChange={togglePlayingEpisodeWatched}
                          />
                          {playingEpisodeWatched ? 'Watched' : 'Unwatched'}
                        </label>
                      {/if}
                    </div>
                  </div>
                </div>
              {:else}
                <div class="min-w-0 flex-1"><span class="text-[10px] uppercase tracking-[0.16em] text-white/50">Now watching</span><h2 class="mt-1 max-w-xl truncate font-medium">{playback.mediaTitle || videoTitle}</h2></div>
              {/if}

              <div class="ml-auto flex shrink-0 items-center gap-2">
                <div class="flex h-7 items-center gap-2.5 rounded-full bg-white/10 px-3 text-[10px] font-medium text-white/62 backdrop-blur-sm" aria-label={phase === 'ready' ? `${torrentDownloaded ? 'Download complete' : `${livePeers} seeders, downloading at ${downloadSpeedLabel}`}, ${playingEpisode?.quality ? `${playingEpisode.quality}p` : 'automatic resolution'}, ${bitrateLabel}` : `${playingEpisode?.quality ? `${playingEpisode.quality}p` : 'automatic resolution'}, ${bitrateLabel}`}>
                  {#if phase === 'ready'}
                    {#if torrentDownloaded}
                      <span class="flex items-center gap-1.5 text-white/82"><Check class="size-3.5 stroke-[2.5]" /> Downloaded</span>
                    {:else}
                      <span class="tabular-nums">{livePeers} {livePeers === 1 ? 'seeder' : 'seeders'}</span>
                      <span class="h-3 w-px bg-white/16" aria-hidden="true"></span>
                      <span class="tabular-nums">↓ {downloadSpeedLabel}</span>
                    {/if}
                    <span class="h-3 w-px bg-white/16" aria-hidden="true"></span>
                  {/if}
                  <span class="text-white/90">{playingEpisode?.quality ? `${playingEpisode.quality}p` : 'Auto'} · {bitrateLabel}</span>
                </div>
                {#if theaterMode}
                  <Button variant="ghost" size="icon" class="pointer-events-auto bg-black/25 text-white hover:bg-white/15 hover:text-white" aria-label="Close theater mode" onclick={() => toggleTheater(false)}><X class="size-4" /></Button>
                {/if}
              </div>
            </div>
            {#snippet episodeSecondaryControls()}
              <Button
                variant="ghost"
                size="icon"
                class="text-white hover:bg-white/10 hover:text-white"
                aria-label="Open queue"
                aria-haspopup="dialog"
                aria-expanded={queueOpen}
                onclick={() => (queueOpen = true)}
              >
                <FileVideo2 class="size-4" />
              </Button>
              <Button variant="ghost" size="sm" class="text-white hover:bg-white/10 hover:text-white" onclick={() => void cycleSpeed()}>{playback.speed}×</Button>
              <Select type="single" value={String(selectedAudio?.id ?? '')} onValueChange={(value) => void selectTrack('aid', String(value))}>
                <SelectTrigger class="hidden h-9 min-w-32 bg-white/10 text-white hover:bg-white/15 md:flex"><AudioLines class="size-4" /><span class="max-w-20 truncate">{selectedAudio?.title || selectedAudio?.lang || 'Audio'}</span></SelectTrigger>
                <SelectContent>{#each audioTracks as track (track.id)}<SelectItem value={String(track.id)}>{track.title || track.lang || `Track ${track.id}`}</SelectItem>{/each}</SelectContent>
              </Select>
              <Select type="single" value={String(selectedSubtitle?.id ?? 'no')} onValueChange={(value) => void selectTrack('sid', String(value))}>
                <SelectTrigger class="hidden h-9 min-w-32 bg-white/10 text-white hover:bg-white/15 md:flex"><Languages class="size-4" /><span class="max-w-20 truncate">{selectedSubtitle?.title || selectedSubtitle?.lang || 'Off'}</span></SelectTrigger>
                <SelectContent><SelectItem value="no">Off</SelectItem>{#each subtitleTracks as track (track.id)}<SelectItem value={String(track.id)}>{track.title || track.lang || `Track ${track.id}`}</SelectItem>{/each}</SelectContent>
              </Select>
            {/snippet}
            <PlayerTransport
              currentTime={displayedPlaybackTime}
              duration={playback.duration}
              progress={displayedPlaybackProgress}
              paused={playback.paused}
              muted={playback.muted}
              volume={playback.volume}
              {theaterMode}
              {fullscreenMode}
              visible={playerUiVisible}
              bufferedRanges={bufferedPlaybackRanges}
              playbackLabel="Playback"
              onTogglePlayback={togglePlayback}
              onSeekRelative={seekRelative}
              onSeekAbsolute={seekAbsolute}
              onToggleMute={toggleMute}
              onChangeVolume={changeVolume}
              onToggleTheater={() => toggleTheater()}
              onToggleFullscreen={toggleFullscreen}
              secondaryControls={episodeSecondaryControls}
            />
          {/if}

          {#if queueOpen && current}
            <div
              class="absolute inset-0 z-50 grid place-items-center bg-black/70 p-5 backdrop-blur-sm"
              role="presentation"
              onclick={(event) => {
                if (event.target === event.currentTarget) queueOpen = false;
              }}
            >
              <Card class="w-full max-w-lg border-white/10 bg-(--bg-elevated) text-(--text) shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="queue-title">
                <div class="flex items-center justify-between border-b border-(--text)/8 px-5 py-4">
                  <div>
                    <span class="text-[10px] uppercase tracking-[0.16em] text-(--text)/35">1 episode</span>
                    <h2 id="queue-title" class="font-medium">Queue</h2>
                  </div>
                  <Button variant="ghost" size="icon" class="size-9" aria-label="Close queue" onclick={() => (queueOpen = false)}><X class="size-4" /></Button>
                </div>
                <CardContent class="p-4">
                  <div class="flex items-center gap-3 rounded-2xl bg-(--text)/6 p-3">
                    <span class="relative grid aspect-video w-24 shrink-0 place-items-center overflow-hidden rounded-xl bg-black text-white">
                      <Play class="size-5" fill="currentColor" />
                      <small class="absolute left-2 top-1.5 text-[8px] tracking-widest text-white/55">NOW</small>
                    </span>
                    <span class="flex min-w-0 flex-1 flex-col">
                      <strong class="truncate text-sm">{nowPlayingTitle}</strong>
                      <small class="mt-1 text-(--text)/38">{formatBytes(current.video.length)} · {bitrateLabel}</small>
                    </span>
                    <Badge>Playing</Badge>
                  </div>
                </CardContent>
              </Card>
            </div>
          {/if}
        </section>

      </main>

  {/if}
  </div>

  {#if trailerPlayback}
    <main
      class="absolute z-40 min-h-0 overflow-hidden {trailerInlineMode ? '' : 'inset-0'} {trailerReady && isTauri() ? 'bg-transparent' : 'bg-black'}"
      style={trailerPlayerStyle}
    >
      <section
        bind:this={trailerViewport}
        class="video-surface relative size-full min-h-0 overflow-hidden"
        class:live={trailerReady}
        class:cursor-none={trailerReady && !playerUiVisible}
        aria-label="Trailer player"
        onpointermove={revealPlayerUi}
        onpointerdown={revealPlayerUi}
      >
        {#if trailerReady}
          <Button
            variant="ghost"
            class="absolute inset-0 z-0 h-auto w-full rounded-none bg-transparent hover:bg-transparent"
            aria-label={trailerPlayback.paused ? 'Play trailer' : 'Pause trailer'}
            onclick={() => void toggleTrailerPlayback()}
          ></Button>
        {/if}

        {#if trailerPlayback.status === 'searching'}
          <div class="absolute inset-0 z-20 grid place-items-center overflow-hidden bg-black text-white">
            {#if trailerPlayback.thumbnail}
              <RevealImage
                class="absolute inset-0 size-full scale-105 object-cover opacity-35 blur-sm saturate-125"
                src={trailerPlayback.thumbnail}
                alt=""
              />
              <span class="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(0,0,0,0.18),rgba(0,0,0,0.86)_72%)]"></span>
            {/if}
            <div class="relative text-center">
              <Spinner class="mx-auto size-10 border-[3px] border-white/15 border-t-white" />
              <p class="mt-4 text-sm font-medium">Searching YouTube</p>
              <p class="mt-1.5 text-xs text-white/48">The first matching trailer will start automatically</p>
            </div>
          </div>
        {:else if trailerPlayback.status === 'buffering'}
          <div class="pointer-events-none absolute inset-0 z-30 grid place-items-center text-white">
            <span class="grid size-14 place-items-center rounded-full border border-white/10 bg-black/45 shadow-xl backdrop-blur-xl">
              <Spinner class="size-7 border-[3px] border-white/15 border-t-white" />
            </span>
          </div>
        {:else if trailerPlayback.status === 'error'}
          <div class="absolute inset-0 z-20 grid place-items-center bg-black p-6">
            <Alert variant="destructive" class="max-w-lg"><AlertCircle class="size-5" /><AlertTitle>Trailer could not start</AlertTitle><AlertDescription>{trailerPlayback.error}</AlertDescription><Button variant="ghost" size="sm" class="mt-3" onclick={() => void closeTrailer()}>Back to Discovery</Button></Alert>
          </div>
        {/if}

        <div class="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start gap-4 bg-gradient-to-b from-black/80 to-transparent p-5 text-white transition-opacity duration-300 {playerUiVisible ? 'opacity-100' : 'opacity-0'}">
          <div class="min-w-0 flex-1"><span class="text-[10px] uppercase tracking-[0.16em] text-white/50">Discovery trailer</span><h2 class="mt-1 max-w-3xl truncate font-medium">{trailerPlayback.mediaTitle || trailerPlayback.title}</h2></div>
          <Button variant="ghost" size="icon" class="pointer-events-auto bg-black/25 text-white hover:bg-white/15 hover:text-white" aria-label="Close trailer" onclick={() => void closeTrailer()}><X class="size-4" /></Button>
        </div>

        {#if trailerReady}
          <PlayerTransport
            currentTime={trailerPlayback.time}
            duration={trailerPlayback.duration}
            progress={trailerPlaybackProgress}
            paused={trailerPlayback.paused}
            muted={trailerPlayback.muted}
            volume={trailerPlayback.volume}
            {theaterMode}
            {fullscreenMode}
            visible={playerUiVisible}
            playbackLabel="Trailer"
            onTogglePlayback={toggleTrailerPlayback}
            onSeekRelative={seekTrailerRelative}
            onSeekAbsolute={seekTrailerAbsolute}
            onToggleMute={toggleTrailerMute}
            onChangeVolume={changeTrailerVolume}
            onToggleTheater={() => toggleTheater()}
            onToggleFullscreen={toggleFullscreen}
          />
        {/if}
      </section>
    </main>
  {/if}
  </div>
</div>

<style>
  .video-surface {
    background:
      radial-gradient(circle at 50% 30%, rgba(255, 255, 255, 0.08), transparent 38%),
      #090909;
  }

  .video-surface.live {
    background: transparent;
  }
</style>
