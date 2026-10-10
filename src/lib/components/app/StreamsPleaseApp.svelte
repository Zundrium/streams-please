<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import * as libmpv from 'tauri-plugin-libmpv-api';
  import type { MpvEvent, MpvEventFromProperties, VideoMarginRatio } from 'tauri-plugin-libmpv-api';
  import {
    AlertCircle,
    AudioLines,
    Check,
    FileVideo2,
    Languages,
    MonitorPlay,
    Play,
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
  import AppNavigation from '$lib/components/app/AppNavigation.svelte';
  import { Generation } from '$lib/async/generation';
  import { OperationTracker } from '$lib/async/operation-tracker';
  import { startPolling } from '$lib/async/polling';
  import { callBackend, isTauri } from '$lib/backend';
  import { posterUrl } from '$lib/catalog';
  import { createCatalogClient } from '$lib/catalog/client';
  import { errorMessage } from '$lib/errors';
  import { libraryEntryMatches } from '$lib/library';
  import { LibraryStore } from '$lib/library-store.svelte';
  import { episodeMediaUrl, openEpisodeStream } from '$lib/player/episode-stream';
  import {
    MPV_WINDOW_LABEL,
    OBSERVED_PROPERTIES,
    TRAILER_LOAD_OPTIONS,
    mpvInitialOptions,
    subtitleLanguagePreference,
    type ObservedProperty
  } from '$lib/player/mpv-config';
  import { MpvClient, type MpvCommands } from '$lib/player/mpv-client';
  import { episodePlaybackKey, planNextEpisode } from '$lib/player/next-episode';
  import {
    applyPlaybackProperty,
    nextPlaybackSpeed,
    percentToTime,
    reconcileSeekTarget,
    signalsPlaybackProgress
  } from '$lib/player/playback-state';
  import { SeekScheduler } from '$lib/player/seek-scheduler';
  import { resolvePlayerShortcut, type PlayerShortcut } from '$lib/player/shortcuts';
  import { StreamLifecycle } from '$lib/player/stream-lifecycle';
  import {
    HIDDEN_VIDEO_MARGINS,
    isPointerAtEdge,
    relativePlacement,
    viewportMargins,
    type InlinePlacement
  } from '$lib/player/viewport';
  import { loadSettings, saveSettings } from '$lib/settings';
  import { localTimezone } from '$lib/time';
  import { formatBytes, normalizeTracks, readableTitle, torrentPieceRanges } from '$lib/torrent/media';
  import { TorrentSession } from '$lib/torrent/session';
  import {
    TrailerPlayerController,
    type TrailerPlaybackState
  } from '$lib/trailer-player';
  import { isSupportedTrailerUrl } from '$lib/trailers';
  import AccountSettingsPage from '$lib/components/settings/AccountSettingsPage.svelte';
  import DiscoveryPage from '$lib/components/catalog/DiscoveryPage.svelte';
  import LibraryPage from '$lib/components/library/LibraryPage.svelte';
  import NextEpisodePrompt from '$lib/components/player/NextEpisodePrompt.svelte';
  import PlayerTransport from '$lib/components/player/PlayerTransport.svelte';
  import RevealImage from '$lib/components/shared/RevealImage.svelte';
  import SearchPage from '$lib/components/catalog/SearchPage.svelte';
  import SubsPleasePage from '$lib/components/catalog/SubsPleasePage.svelte';
  import TasteIndicator from '$lib/components/catalog/TasteIndicator.svelte';
  import UpdateStatus from '$lib/components/app/UpdateStatus.svelte';
  import { checkForUpdate, createUpdateController, installPendingUpdate } from '$lib/updates';
  import type {
    AppUpdateStatus,
    AppView,
    CurrentTorrent,
    EpisodePlaybackRequest,
    LibraryBackupEntry,
    MpvTrack,
    Phase,
    PlaybackQuality,
    PlaybackState,
    RuntimeInfo,
    SubtitleLanguage,
    TrailerPlaybackRequest,
    TorrentStats
  } from '$lib/types';

  type TrailerResumeState = {
    torrent: CurrentTorrent;
    playback: PlaybackState;
    tracks: MpvTrack[];
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

  const catalogClient = createCatalogClient();
  const {
    loadSearch: loadAniListSearch,
    loadSeason: loadAniListSeason,
    loadRecommendations: loadCatalogRecommendations,
    loadIndex: loadSubsPleaseIndex,
    loadSchedule: loadSubsPleaseSchedule,
    loadShow: loadSubsPleaseShow
  } = catalogClient;

  const MIN_STREAM_START_BYTES = 1024 * 1024;
  const STREAM_RETRY_DELAY_MS = 5_000;
  const MAX_STREAM_FAILURES = 3;
  const PLAYBACK_START_TIMEOUT_MS = 20_000;
  const PLAYBACK_PROBE_INTERVAL_MS = 250;
  const MEDIA_LOAD_TIMEOUT_MS = 8_000;
  const NEXT_EPISODE_PROMPT_SECONDS = 80;
  const TORRENT_STATUS_INTERVAL_MS = 1_000;
  const PLAYER_UI_HIDE_DELAY_MS = 5_000;
  const SEEK_STEP_SECONDS = 10;
  const PREVIEW_TRACKS: MpvTrack[] = [
    { id: 1, type: 'video', codec: 'h264', selected: true },
    { id: 2, type: 'audio', lang: 'jpn', title: 'Japanese', codec: 'aac', selected: true },
    { id: 3, type: 'audio', lang: 'eng', title: 'English', codec: 'aac' },
    { id: 4, type: 'sub', lang: 'eng', title: 'English • ASS', codec: 'ass', selected: true },
    { id: 5, type: 'sub', lang: 'nld', title: 'Dutch', codec: 'ass' }
  ];

  let contentViewport = $state<HTMLElement | null>(null);
  let videoViewport = $state<HTMLElement | null>(null);
  let trailerViewport = $state<HTMLElement | null>(null);
  let trailerInlineAnchor: HTMLElement | null = null;
  let trailerPlacement = $state<InlinePlacement | null>(null);
  let playerUiTimer: ReturnType<typeof setTimeout> | null = null;
  let trailerOriginView = $state<AppView | null>(null);
  let mpvMediaOwner: MpvMediaOwner = 'episode';
  const episodeOperations = new OperationTracker();
  const viewRequests = new Generation();
  const episodeRequests = new Generation();

  let runtime = $state<RuntimeInfo | null>(null);
  let activeView = $state<AppView>('library');
  let episodeOriginView = $state<AppView>('subsplease');
  const library = new LibraryStore();
  const {
    syncShow: syncLibraryShow,
    toggleShow: toggleLibraryShow,
    setVerdict: setDiscoveryVerdict,
    setEpisodeWatched,
    toggleEpisodeWatched,
    setEpisodeProgress
  } = library;
  const decideDiscoveryShow = setDiscoveryVerdict;
  let libraryEntries = $derived(library.entries);
  let playingEpisode = $state<EpisodePlaybackRequest | null>(null);
  let nextEpisode = $state<EpisodePlaybackRequest | null>(null);
  let nextEpisodeFromLibrary = $state(false);
  let nextEpisodeStarting = $state(false);
  let nextEpisodeDismissedFor = $state('');
  let requestedShowSlug = $state('');
  let theaterMode = $state(false);
  let fullscreenMode = $state(false);
  let playerUiVisible = $state(true);
  let preferredQuality = $state<PlaybackQuality>('1080');
  let preferredSubtitleLanguage = $state<SubtitleLanguage>('en');
  let autoMarkedPlaybackKey = '';
  let phase = $state<Phase>('idle');
  let error = $state('');
  let updateStatus = $state<AppUpdateStatus | null>(null);
  const updateController = createUpdateController({
    checkForUpdate,
    installPendingUpdate,
    onStatusChange: (status) => (updateStatus = status)
  });
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

  const mpv = new MpvClient(libmpv, {
    windowLabel: MPV_WINDOW_LABEL,
    observedProperties: OBSERVED_PROPERTIES,
    enabled: isTauri,
    initialOptions: () => mpvInitialOptions(preferredSubtitleLanguage),
    initialMargins: () => (mpvMediaOwner === 'transition' ? HIDDEN_VIDEO_MARGINS : currentVideoMargins()),
    onProperty: onMpvProperty,
    onEvent: onMpvEvent,
    loadTimeoutMs: MEDIA_LOAD_TIMEOUT_MS
  });

  const stream = new StreamLifecycle({
    minStartBytes: MIN_STREAM_START_BYTES,
    retryDelayMs: STREAM_RETRY_DELAY_MS,
    maxFailures: MAX_STREAM_FAILURES,
    watchdogMs: PLAYBACK_START_TIMEOUT_MS,
    phase: () => phase,
    onPhase: (nextPhase, message) => {
      phase = nextPhase;
      if (message !== undefined) error = message;
    }
  });

  const seeks = new SeekScheduler({
    perform: (target) => mpv.run((player) => player.seek(target)),
    canSeek: () => Boolean(current) && mpvMediaOwner === 'episode',
    onError: (target, reason) => {
      if (seekTarget !== target) return;
      seekTarget = null;
      error = `Seek could not be completed: ${errorMessage(reason)}`;
    },
    track: (operation) => episodeOperations.track(operation)
  });

  const torrents = new TorrentSession(
    {
      addMagnet: (magnet) => callBackend('add_magnet', { magnet }),
      release: async (id) => {
        if (isTauri()) await callBackend('release_torrent', { id });
      }
    },
    {
      stopPlayback: async () => {
        if (isTauri() && mpv.ready) await mpv.run((player) => player.stop());
      },
      onCleared: resetEpisodeState,
      onStarted: beginEpisode
    }
  );

  const trailerController = new TrailerPlayerController<TrailerSessionContext>(
    {
      open: openTrailerSession,
      prepare: prepareTrailerSession,
      load: loadTrailerMedia,
      abort: abortTrailerSession,
      teardown: teardownTrailerSession,
      setPaused: (paused) => mpv.run((player) => player.setFlag('pause', paused)),
      seek: (time) => mpv.run((player) => player.seek(time)),
      setVolume: (volume) => mpv.run((player) => player.setNumber('volume', volume)),
      setMuted: (muted) => mpv.run((player) => player.setFlag('mute', muted))
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
      Date.now() - stream.bufferingStartedAt > 12_000 &&
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
  let nextEpisodePromptVisible = $derived.by(() => {
    if (
      activeView !== 'player' ||
      phase !== 'ready' ||
      trailerPlayback !== null ||
      !current ||
      !playingEpisode ||
      !nextEpisode ||
      playback.duration <= 0 ||
      playback.time <= 0 ||
      nextEpisodeDismissedFor === episodePlaybackKey(playingEpisode)
    ) {
      return false;
    }
    return playback.duration - playback.time <= NEXT_EPISODE_PROMPT_SECONDS;
  });

  onMount(() => {
    const settings = loadSettings();
    preferredQuality = settings.preferredQuality;
    preferredSubtitleLanguage = settings.preferredSubtitleLanguage;
    startAppUpdate();
    void callBackend('runtime_info')
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
      const target = event.target;
      const shortcut = resolvePlayerShortcut(
        {
          key: event.key,
          code: event.code,
          fromEditable: target instanceof Element && target.matches('input, textarea, select, button')
        },
        {
          queueOpen,
          fullscreen: fullscreenMode,
          trailerOpen: Boolean(trailerPlayback),
          theater: theaterMode,
          episodeLoaded: Boolean(torrents.current)
        }
      );
      if (!shortcut) return;
      if (shortcut === 'toggle-playback') event.preventDefault();
      runShortcut(shortcut);
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (playerUiTimer !== null) clearTimeout(playerUiTimer);
      mpv.dispose();
      trailerController.dispose();
      stream.dispose();
      seeks.invalidate();
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
    return startPolling(async (isActive) => {
      const nextStats = await callBackend('torrent_status', { id }).catch(() => null);
      if (!isActive() || torrents.current?.id !== id) return false;
      if (nextStats) {
        stream.updateStats(nextStats);
        stats = nextStats;
      }
    }, TORRENT_STATUS_INTERVAL_MS);
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
    if (!isTauri() || !mpv.ready) return;
    if (trailer || view === 'player') {
      window.requestAnimationFrame(() => void syncVideoViewport());
    } else {
      void hideVideo().catch(() => undefined);
    }
  });

  $effect(() => {
    const hasActivePlayer = trailerPlayerOpen || episodePlayerOpen;
    if (hasActivePlayer) {
      revealPlayerUi();
    } else if (playerUiTimer !== null) {
      clearTimeout(playerUiTimer);
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
    const key = episodePlaybackKey(episode);
    if (autoMarkedPlaybackKey === key) return;
    autoMarkedPlaybackKey = key;
    setEpisodeWatched({ anilistId: episode.anilistId, slug: episode.slug }, episode.episode, true);
  });

  $effect(() => {
    const target = current;
    const nextStats = stats;
    if (
      !isTauri() ||
      mpvMediaOwner !== 'episode' ||
      trailerPlayback !== null ||
      !target ||
      !nextStats
    ) {
      return;
    }
    const attempt = stream.claimAttempt();
    if (attempt !== null) void openTorrentStream(target, attempt);
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

  function runShortcut(shortcut: PlayerShortcut): void {
    const trailer = Boolean(trailerPlayback);
    const actions: Record<PlayerShortcut, () => unknown> = {
      'close-queue': () => (queueOpen = false),
      'exit-fullscreen': () => toggleFullscreen(false),
      'close-trailer': closeTrailer,
      'exit-theater': () => toggleTheater(false),
      'toggle-playback': trailer ? toggleTrailerPlayback : togglePlayback,
      'seek-backward': () =>
        trailer ? seekTrailerRelative(-SEEK_STEP_SECONDS) : seekRelative(-SEEK_STEP_SECONDS),
      'seek-forward': () =>
        trailer ? seekTrailerRelative(SEEK_STEP_SECONDS) : seekRelative(SEEK_STEP_SECONDS),
      'toggle-mute': trailer ? toggleTrailerMute : toggleMute,
      'toggle-fullscreen': () => toggleFullscreen()
    };
    void Promise.resolve()
      .then(actions[shortcut])
      .catch((reason) => console.warn(`The ${shortcut} shortcut failed.`, reason));
  }

  function updateTrailerPlacement() {
    if (!trailerInlineAnchor || !contentViewport || !trailerInlineAnchor.isConnected) return;
    trailerPlacement = relativePlacement(
      trailerInlineAnchor.getBoundingClientRect(),
      contentViewport.getBoundingClientRect()
    );
  }

  function currentVideoMargins(): VideoMarginRatio | null {
    const viewport = trailerPlayback ? trailerViewport : videoViewport;
    if (!viewport) return null;
    return viewportMargins(viewport.getBoundingClientRect(), window.innerWidth, window.innerHeight);
  }

  function hideVideo(): Promise<void> {
    return mpv.run((player) => player.setMargins(HIDDEN_VIDEO_MARGINS));
  }

  async function syncVideoViewport() {
    if (mpvMediaOwner === 'transition') return;
    const margins = currentVideoMargins();
    if (margins) await mpv.syncMargins(margins);
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

  function suspendEpisodeOperations(): void {
    stream.suspend();
    seeks.invalidate();
    seekTarget = null;
  }

  function captureResumeState(torrent: CurrentTorrent): TrailerResumeState {
    return { torrent, playback: { ...playback, paused: true }, tracks: [...tracks] };
  }

  function openTrailerSession(request: TrailerPlaybackRequest): TrailerSessionContext {
    const inlineAnchor = request.viewport?.isConnected ? request.viewport : null;
    const torrent = torrents.current;
    const context: TrailerSessionContext = {
      originView: activeView,
      inlineAnchor,
      inlineAnchorVisibility: inlineAnchor?.style.visibility ?? '',
      resume: torrent ? captureResumeState(torrent) : null,
      requiresEpisodeReload: Boolean(torrent && phase !== 'ready'),
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

    await episodeOperations.settled();
    if (cancelled()) return;
    if (torrents.current && !playback.paused) await pausePlayback();
    if (cancelled()) return;
    const torrent = torrents.current;
    if (context.resume && torrent) context.resume = captureResumeState(torrent);

    const nextRuntime = runtime ?? (await callBackend('runtime_info'));
    if (cancelled()) return;
    runtime = nextRuntime;
    if (!nextRuntime.mpvAvailable) {
      throw new Error('The bundled in-process video engine is unavailable.');
    }
    if (!nextRuntime.trailerAvailable) {
      throw new Error('The bundled YouTube trailer resolver is unavailable.');
    }

    await mpv.ensure();
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
      await mpv.run((player) => player.setMargins({ top: 1 }));
      if (cancelled()) return;
    }

    mpvMediaOwner = 'trailer';
    await mpv.run(async (player) => {
      await player.setNumber('speed', 1);
      if (cancelled()) return;
      await player.setNumber('volume', initial.volume);
      if (cancelled()) return;
      await player.setFlag('mute', initial.muted);
      if (cancelled()) return;
      await player.loadFile(request.url, TRAILER_LOAD_OPTIONS);
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
      const torrent = torrents.current;
      const sameTorrent =
        resume &&
        torrent &&
        resume.torrent.id === torrent.id &&
        resume.torrent.fileId === torrent.fileId;
      const shouldReloadEpisode = mediaWasReplaced || context.requiresEpisodeReload;
      if (isTauri() && shouldReloadEpisode && sameTorrent && resume) {
        await restoreEpisodeAfterTrailer(resume);
      } else if (resume) {
        playback = { ...resume.playback, paused: true };
        tracks = resume.tracks;
      }
    } catch (reason) {
      phase = 'error';
      error = `The episode could not be restored after the trailer: ${errorMessage(reason)}`;
    } finally {
      mpvMediaOwner = 'episode';
      trailerOriginView = null;
      if (context.inlineAnchor?.isConnected) {
        context.inlineAnchor.style.visibility = context.inlineAnchorVisibility;
      }
      trailerInlineAnchor = null;
      trailerPlacement = null;

      if (activeView === 'player' && torrents.current) {
        scheduleVideoViewportSync();
      } else if (isTauri() && mpv.ready) {
        await hideVideo().catch(() => undefined);
      }
    }
  }

  async function stopTrailerMedia(
    context: TrailerSessionContext,
    mediaWasReplaced: boolean
  ): Promise<void> {
    if (!isTauri() || !mpv.ready) return;

    const failures: string[] = [];
    const attempt = (operation: (player: MpvCommands) => Promise<void>) =>
      mpv.run(operation).catch((reason) => {
        failures.push(errorMessage(reason));
      });
    await attempt((player) => player.setMargins(HIDDEN_VIDEO_MARGINS));
    if (mediaWasReplaced) await attempt((player) => player.stop());
    else if (context.resume) await attempt((player) => player.setFlag('pause', true));
    if (!failures.length) return;

    try {
      await mpv.destroy();
      context.requiresEpisodeReload = Boolean(context.resume);
    } catch (reason) {
      throw new Error(
        `${failures.join(' ')} The mpv instance also could not be reset: ${errorMessage(reason)}`
      );
    }
  }

  async function restoreEpisodeAfterTrailer(resume: TrailerResumeState): Promise<void> {
    const streamUrl = await callBackend('stream_url', {
      id: resume.torrent.id,
      fileId: resume.torrent.fileId
    });
    await mpv.loadAndWait(episodeMediaUrl(streamUrl, resume.torrent), streamUrl);
    mpvMediaOwner = 'episode';
    const selectedAudio = resume.tracks.find((track) => track.type === 'audio' && track.selected);
    const selectedSubtitle = resume.tracks.find((track) => track.type === 'sub' && track.selected);
    playback = { ...resume.playback, paused: true };
    tracks = resume.tracks;
    await mpv.run(async (player) => {
      if (resume.playback.time > 0) await player.seek(resume.playback.time);
      await player.setNumber('speed', resume.playback.speed);
      await player.setNumber('volume', resume.playback.volume);
      await player.setFlag('mute', resume.playback.muted);
      await player.selectTrack('aid', selectedAudio?.id ?? 'auto');
      await player.selectTrack('sid', selectedSubtitle?.id ?? 'no');
      await player.setFlag('pause', true);
    });
  }

  async function changeActiveView(nextView: AppView): Promise<void> {
    if (nextView === activeView) return;
    const generation = viewRequests.next();
    if (trailerPlayback) await closeTrailer();
    if (!viewRequests.isCurrent(generation) || trailerController.active) return;
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
    await trailerController.seek(percentToTime(percent, trailerPlayback.duration));
  }

  async function changeTrailerVolume(volume: number): Promise<void> {
    await trailerController.changeVolume(volume);
  }

  async function toggleTrailerMute(): Promise<void> {
    await trailerController.toggleMute();
  }

  function onTrailerProperty(event: MpvEventFromProperties<ObservedProperty>): void {
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
  }

  function onEpisodeProperty(event: MpvEventFromProperties<ObservedProperty>): void {
    if (event.name === 'track-list') {
      tracks = normalizeTracks(event.data);
      return;
    }
    if (event.name === 'paused-for-cache') {
      stream.cacheStateChanged(Boolean(event.data), playback.duration > 0 || playback.time > 0);
      return;
    }
    playback = applyPlaybackProperty(playback, event.name, event.data);
    if (event.name === 'time-pos') seekTarget = reconcileSeekTarget(seekTarget, playback.time);
    if (signalsPlaybackProgress(event.name, event.data)) stream.progressObserved();
  }

  function onMpvProperty(event: MpvEventFromProperties<ObservedProperty>): void {
    if (mpvMediaOwner === 'trailer') onTrailerProperty(event);
    else if (mpvMediaOwner === 'episode') onEpisodeProperty(event);
  }

  function onMpvEvent(event: MpvEvent): void {
    if (mpvMediaOwner === 'trailer') {
      if (event.event === 'video-reconfig') scheduleVideoViewportSync();
      trailerController.handleEvent(event);
      return;
    }
    if (mpvMediaOwner !== 'episode') return;
    if (event.event === 'start-file') stream.fileStarted();
    if (event.event === 'playback-restart') stream.markReady();
    if (event.event === 'end-file' && event.reason === 'error') {
      stream.fail('mpv could not open the local torrent stream yet.');
    }
  }

  function openTorrentStream(target: CurrentTorrent, attempt: number): Promise<void> {
    const opening = openEpisodeStream(target, {
      mpv,
      streamUrl: (torrent) => callBackend('stream_url', { id: torrent.id, fileId: torrent.fileId }),
      isActive: () => stream.isCurrent(attempt) && mpvMediaOwner === 'episode',
      isReady: () => phase === 'ready',
      markReady: () => stream.markReady(),
      margins: currentVideoMargins,
      resumeAt: () => seekTarget ?? playback.time,
      livePeers: () => stream.livePeers,
      startTimeoutMs: PLAYBACK_START_TIMEOUT_MS,
      probeIntervalMs: PLAYBACK_PROBE_INTERVAL_MS
    });
    return episodeOperations
      .track(opening)
      .catch((reason) => stream.fail(errorMessage(reason), attempt));
  }

  function resetEpisodeState(): void {
    stream.begin(null);
    seeks.invalidate();
    current = null;
    playingEpisode = null;
    stats = null;
    tracks = [];
    seekTarget = null;
  }

  async function beginEpisode(torrent: CurrentTorrent): Promise<void> {
    stream.begin(torrent);
    stats = null;
    current = torrent;
    phase = 'buffering';
    playback = { ...playback, paused: false, time: 0, duration: 0 };

    if (isTauri()) {
      await mpv.ensure();
      return;
    }
    tracks = PREVIEW_TRACKS.map((track) => ({ ...track }));
    playback = { ...playback, duration: 888, paused: false };
    phase = 'ready';
  }

  function failPlayback(message: string): false {
    error = message;
    phase = 'error';
    return false;
  }

  async function startTorrent(releaseMagnet: string): Promise<boolean> {
    error = '';
    const magnet = releaseMagnet.trim();
    if (!magnet.startsWith('magnet:?')) return failPlayback('Enter a valid magnet link.');
    if (isTauri() && runtime && !runtime.mpvAvailable) {
      return failPlayback(
        'The bundled libmpv runtime is missing. Reinstall StreamsPlease or run the libmpv setup step.'
      );
    }

    phase = 'connecting';
    try {
      const result = await torrents.start(magnet);
      return result.status === 'started';
    } catch (reason) {
      return failPlayback(errorMessage(reason));
    }
  }

  function importLibrary(backups: LibraryBackupEntry[]): Promise<{ failed: string[] }> {
    return library.importBackups(backups, {
      timezone: localTimezone(),
      loadSchedule: loadSubsPleaseSchedule,
      loadShow: (slug, timezone, anilistId) => loadSubsPleaseShow(slug, timezone, anilistId)
    });
  }

  function updatePreferredQuality(quality: PlaybackQuality) {
    preferredQuality = quality;
    saveSettings({ preferredQuality: quality, preferredSubtitleLanguage });
  }

  function updatePreferredSubtitleLanguage(language: SubtitleLanguage) {
    preferredSubtitleLanguage = language;
    saveSettings({ preferredQuality, preferredSubtitleLanguage: language });
    if (isTauri() && mpv.ready) {
      void mpv
        .run((player) => player.setSubtitleLanguages(subtitleLanguagePreference(language)))
        .catch(() => undefined);
    }
  }

  async function prepareNextEpisode(request: EpisodePlaybackRequest, generation: number): Promise<void> {
    const sourceKey = episodePlaybackKey(request);
    const plan = await planNextEpisode(request, {
      timezone: localTimezone(),
      preferredQuality,
      libraryEntries: () => library.entries,
      loadShow: loadSubsPleaseShow,
      isCurrent: () =>
        episodeRequests.isCurrent(generation) &&
        playingEpisode !== null &&
        episodePlaybackKey(playingEpisode) === sourceKey
    });
    if (!plan) return;
    nextEpisodeFromLibrary = plan.fromLibrary;
    nextEpisode = plan.episode;
  }

  async function playSubsPleaseRelease(request: EpisodePlaybackRequest) {
    const generation = episodeRequests.next();
    const originView = activeView === 'player' ? episodeOriginView : activeView;
    nextEpisode = null;
    nextEpisodeFromLibrary = false;
    nextEpisodeDismissedFor = '';
    await changeActiveView('player');
    if (activeView !== 'player' || !episodeRequests.isCurrent(generation)) return;
    episodeOriginView = originView;
    queueOpen = false;
    playingEpisode = null;
    autoMarkedPlaybackKey = '';
    const started = await startTorrent(request.magnet);
    if (!started || !episodeRequests.isCurrent(generation)) return;
    playingEpisode = request;
    void prepareNextEpisode(request, generation);
  }

  function dismissNextEpisode(): void {
    if (playingEpisode) nextEpisodeDismissedFor = episodePlaybackKey(playingEpisode);
  }

  async function playNextEpisode(): Promise<void> {
    const request = nextEpisode;
    if (!request || nextEpisodeStarting) return;
    nextEpisodeStarting = true;
    try {
      await playSubsPleaseRelease(request);
    } finally {
      nextEpisodeStarting = false;
    }
  }

  function returnToShowDetails() {
    if (!playingEpisode) return;
    requestedShowSlug = playingEpisode.slug;
    theaterMode = false;
    activeView = episodeDetailsView();
    window.setTimeout(() => void syncVideoViewport(), 120);
  }

  function episodeDetailsView(): AppView {
    if (playingLibraryEntry) return 'library';
    return episodeOriginView === 'search' ? 'search' : 'subsplease';
  }

  function consumeShowRequest() {
    requestedShowSlug = '';
  }

  async function togglePlayback() {
    if (!current) return;
    const paused = !playback.paused;
    if (isTauri()) await mpv.run((player) => player.setFlag('pause', paused));
    playback = { ...playback, paused };
  }

  async function pausePlayback() {
    if (!current || playback.paused) return;
    playback = { ...playback, paused: true };
    if (isTauri()) await mpv.run((player) => player.setFlag('pause', true)).catch(() => undefined);
  }

  function canConcealPlayerUi(): boolean {
    return Boolean(trailerPlayback || (activeView === 'player' && current && !queueOpen));
  }

  function revealPlayerUi() {
    playerUiVisible = true;
    if (playerUiTimer !== null) clearTimeout(playerUiTimer);
    playerUiTimer = setTimeout(() => {
      playerUiTimer = null;
      if (canConcealPlayerUi()) playerUiVisible = false;
    }, PLAYER_UI_HIDE_DELAY_MS);
  }

  function concealPlayerUi(event: PointerEvent) {
    const surface = event.currentTarget;
    if (
      event.buttons !== 0 ||
      !canConcealPlayerUi() ||
      (surface instanceof Element &&
        surface.querySelector('[data-slot="select-trigger"][data-state="open"]'))
    ) {
      return;
    }
    if (playerUiTimer !== null) clearTimeout(playerUiTimer);
    playerUiTimer = null;
    playerUiVisible = false;
  }

  function trackPlayerPointer(event: PointerEvent) {
    const surface = event.currentTarget;
    if (
      event.pointerType === 'mouse' &&
      surface instanceof Element &&
      isPointerAtEdge(surface.getBoundingClientRect(), event.clientX, event.clientY)
    ) {
      concealPlayerUi(event);
    } else {
      revealPlayerUi();
    }
  }

  function toggleTheater(force?: boolean) {
    theaterMode = force ?? !theaterMode;
    revealPlayerUi();
    scheduleVideoViewportSync();
  }

  function togglePlayingEpisodeWatched(watched: boolean) {
    if (!playingEpisode || !playingLibraryEntry || watched === playingEpisodeWatched) return;
    setEpisodeWatched(
      { anilistId: playingEpisode.anilistId, slug: playingEpisode.slug },
      playingEpisode.episode,
      watched
    );
  }

  function scheduleSeek(time: number) {
    if (!current || playback.duration <= 0) return;
    const target = Math.max(0, Math.min(playback.duration, time));
    if (!isTauri()) {
      playback = { ...playback, time: target };
      seekTarget = null;
      return;
    }
    seekTarget = target;
    seeks.schedule(target);
  }

  function seekRelative(seconds: number) {
    if (!current) return;
    scheduleSeek((seeks.pendingTarget ?? seekTarget ?? playback.time) + seconds);
  }

  function seekAbsolute(percent: number) {
    if (!current) return;
    scheduleSeek(percentToTime(percent, playback.duration));
  }

  async function changeVolume(volume: number) {
    playback = { ...playback, volume, muted: false };
    if (isTauri()) {
      await mpv.run((player) => player.setFlag('mute', false));
      await mpv.run((player) => player.setNumber('volume', volume));
    }
  }

  async function toggleMute() {
    const muted = !playback.muted;
    playback = { ...playback, muted };
    if (isTauri()) await mpv.run((player) => player.setFlag('mute', muted));
  }

  async function cycleSpeed() {
    const speed = nextPlaybackSpeed(playback.speed);
    playback = { ...playback, speed };
    if (isTauri()) await mpv.run((player) => player.setNumber('speed', speed));
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
    const choice = value === 'no' ? 'no' : Number(value);
    if (choice !== 'no' && !Number.isSafeInteger(choice)) return;
    const previousTracks = tracks;
    tracks = tracks.map((track) => {
      const matchesType = type === 'sid' ? track.type === 'sub' : track.type === 'audio';
      return matchesType ? { ...track, selected: track.id === choice } : track;
    });
    if (!isTauri()) return;

    try {
      await mpv.run((player) => player.selectTrack(type, choice));
    } catch (reason) {
      tracks = previousTracks;
      error = `The track could not be changed: ${errorMessage(reason)}`;
    }
  }

  async function retryPlayback() {
    const torrent = current;
    if (!torrent || trailerPlayback || mpvMediaOwner !== 'episode') return;
    error = '';
    stream.restart();
    phase = 'buffering';
    if (!isTauri()) return;
    const attempt = stream.claimRetry();
    if (attempt !== null) await openTorrentStream(torrent, attempt);
  }

  function startAppUpdate() {
    if (!isTauri()) return;
    void updateController.check();
  }

  function acceptAppUpdate() {
    if (!isTauri()) return;
    void updateController.accept();
  }

</script>

<div class="grid h-screen min-h-0 grid-cols-[minmax(0,1fr)] overflow-hidden text-(--text) {immersiveMode ? 'grid-rows-[minmax(0,1fr)]' : 'grid-rows-[4rem_minmax(0,1fr)]'}">
  {#if !immersiveMode}
  <AppNavigation {activeView} onNavigate={(view) => void changeActiveView(view)} />
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
  {:else if activeView === 'search'}
    <SearchPage
      loadSearch={loadAniListSearch}
      loadIndex={loadSubsPleaseIndex}
      loadShow={loadSubsPleaseShow}
      onPlay={playSubsPleaseRelease}
      onPlayTrailer={playTrailer}
      {libraryEntries}
      onToggleLibrary={toggleLibraryShow}
      onSetDiscoveryVerdict={setDiscoveryVerdict}
      onToggleWatched={toggleEpisodeWatched}
      onShowLoaded={syncLibraryShow}
      {preferredQuality}
      openSlug={requestedShowSlug}
      onOpenConsumed={consumeShowRequest}
    />
  {:else if activeView === 'discovery'}
    <DiscoveryPage
      loadSeason={loadAniListSeason}
      loadRecommendations={loadCatalogRecommendations}
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
      {libraryEntries}
      onQualityChange={updatePreferredQuality}
      onSubtitleLanguageChange={updatePreferredSubtitleLanguage}
      onLibraryImport={importLibrary}
    />
  {:else}
    <main class="h-full min-h-0 {current && phase !== 'error' && isTauri() ? 'bg-transparent' : 'bg-black'}">
        <section
          bind:this={videoViewport}
          class="video-surface relative h-full min-h-0 overflow-hidden {current && phase !== 'error' ? 'live' : ''}"
          class:cursor-none={current && !playerUiVisible}
          aria-label="Video player"
          onpointermove={trackPlayerPointer}
          onpointerdown={revealPlayerUi}
          onpointerleave={concealPlayerUi}
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
            {#if nextEpisodePromptVisible && nextEpisode}
              <NextEpisodePrompt
                title={nextEpisode.title}
                episode={nextEpisode.episode}
                imageUrl={posterUrl(nextEpisode.imageUrl)}
                eyebrow={nextEpisodeFromLibrary ? 'From your library' : 'Up next'}
                actionLabel={nextEpisodeFromLibrary ? 'Watch episode' : 'Watch next'}
                busy={nextEpisodeStarting}
                onDismiss={dismissNextEpisode}
                onWatch={playNextEpisode}
              />
            {/if}
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
        onpointermove={trackPlayerPointer}
        onpointerdown={revealPlayerUi}
        onpointerleave={concealPlayerUi}
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

{#if updateStatus}
  <UpdateStatus
    status={updateStatus}
    onAccept={acceptAppUpdate}
    onRetry={startAppUpdate}
    onDismiss={() => (updateStatus = null)}
  />
{/if}

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
