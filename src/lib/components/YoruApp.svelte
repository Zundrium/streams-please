<script lang="ts">
  import { onMount } from 'svelte';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import {
    command as mpvCommand,
    getProperty,
    init as initMpv,
    listenEvents,
    observeProperties,
    setProperty,
    setVideoMarginRatio,
    type MpvEventFromProperties,
    type MpvObservableProperty
  } from 'tauri-plugin-libmpv-api';
  import {
    AlertCircle,
    AudioLines,
    BookOpen,
    CalendarDays,
    CircleUserRound,
    FastForward,
    FileVideo2,
    Languages,
    Maximize,
    MonitorPlay,
    Pause,
    Play,
    Rewind,
    Sparkles,
    Theater,
    Volume2,
    VolumeX,
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
  import { Slider } from '$lib/components/ui/slider';
  import { Spinner } from '$lib/components/ui/spinner';
  import { Switch } from '$lib/components/ui/switch';
  import { Tabs, TabsList, TabsTrigger } from '$lib/components/ui/tabs';
  import { callBackend, isTauri } from '$lib/backend';
  import {
    entryFromDiscovery,
    entryFromShow,
    loadLibrary,
    saveLibrary,
    sortEpisodeNumbers
  } from '$lib/library';
  import { loadSettings, saveSettings } from '$lib/settings';
  import AccountSettingsPage from '$lib/components/AccountSettingsPage.svelte';
  import DiscoveryPage from '$lib/components/DiscoveryPage.svelte';
  import LibraryPage from '$lib/components/LibraryPage.svelte';
  import SubsPleasePage from '$lib/components/SubsPleasePage.svelte';
  import type {
    AddTorrentResponse,
    AniListSearchResult,
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
    SubsPleaseScheduleResponse,
    SubsPleaseScheduleShow,
    SubsPleaseShowResponse,
    TrailerPlaybackRequest,
    TorrentStats
  } from '$lib/types';

  type TrailerPlaybackState = TrailerPlaybackRequest & {
    loading: boolean;
    ready: boolean;
    error: string;
    paused: boolean;
    time: number;
    duration: number;
    volume: number;
    muted: boolean;
    mediaTitle?: string;
  };

  type TrailerResumeState = {
    torrent: CurrentTorrent;
    playback: PlaybackState;
  };

  const OBSERVED_PROPERTIES = [
    ['pause', 'flag'],
    ['time-pos', 'double', 'none'],
    ['duration', 'double', 'none'],
    ['volume', 'double'],
    ['mute', 'flag'],
    ['speed', 'double'],
    ['track-list', 'node'],
    ['media-title', 'string', 'none'],
    ['paused-for-cache', 'flag']
  ] as const satisfies readonly MpvObservableProperty[];
  const VIDEO_EXTENSIONS = ['.mkv', '.mk3d', '.mp4', '.m4v', '.mov', '.webm', '.avi', '.ts', '.m2ts'];
  const MIN_STREAM_START_BYTES = 1024 * 1024;
  const STREAM_RETRY_DELAY_MS = 5_000;
  const MAX_STREAM_FAILURES = 3;
  const PLAYBACK_START_TIMEOUT_MS = 20_000;
  const PLAYBACK_PROBE_INTERVAL_MS = 250;
  const SEEK_DEBOUNCE_MS = 180;
  const SEEK_BUFFER_SECONDS = 3;
  const SEEK_BUFFER_TIMEOUT_MS = 8_000;
  const MPV_WINDOW_LABEL = 'main';

  let videoViewport = $state<HTMLElement | null>(null);
  let trailerViewport = $state<HTMLElement | null>(null);
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
  let seekTimer: number | null = null;
  let pendingSeekTime: number | null = null;
  let seekGeneration = 0;
  let playerUiTimer: number | null = null;
  let trailerRef: TrailerPlaybackState | null = null;
  let trailerResume: TrailerResumeState | null = null;
  let trailerReplacedMedia = false;
  let trailerOperationGeneration = 0;
  let trailerStartPromise: Promise<void> | null = null;
  let restoringEpisode = false;

  let runtime = $state<RuntimeInfo | null>(null);
  let activeView = $state<AppView>('library');
  let libraryEntries = $state<LibraryEntry[]>([]);
  let playingEpisode = $state<EpisodePlaybackRequest | null>(null);
  let requestedShowSlug = $state('');
  let theaterMode = $state(false);
  let playerUiVisible = $state(true);
  let preferredQuality = $state<PlaybackQuality>('1080');
  let autoMarkedPlaybackKey = '';
  let phase = $state<Phase>('idle');
  let error = $state('');
  let current = $state<CurrentTorrent | null>(null);
  let stats = $state<TorrentStats | null>(null);
  let queueOpen = $state(false);
  let tracks = $state<MpvTrack[]>([]);
  let seekTarget = $state<number | null>(null);
  let isSeeking = $state(false);
  let seekCacheDuration = $state(0);
  let playback = $state<PlaybackState>({
    paused: true,
    time: 0,
    duration: 0,
    volume: 80,
    muted: false,
    speed: 1
  });
  let trailerPlayback = $state<TrailerPlaybackState | null>(null);

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
  let trailerPlaybackProgress = $derived(
    trailerPlayback?.duration
      ? Math.max(0, Math.min(100, (trailerPlayback.time / trailerPlayback.duration) * 100))
      : 0
  );
  let livePeers = $derived(stats?.live?.snapshot.peer_stats.live ?? 0);
  let downloadSpeed = $derived(stats?.live?.download_speed.mbps ?? 0);
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
          (entry) => entry.slug === playingEpisode?.slug && entry.following
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
    preferredQuality = loadSettings().preferredQuality;
    void callBackend<RuntimeInfo>('runtime_info')
      .then((nextRuntime) => (runtime = nextRuntime))
      .catch((reason) => (error = String(reason)));

    const onResize = () => void syncVideoViewport();
    window.addEventListener('resize', onResize);

    const onVisibilityChange = () => {
      if (!document.hidden) return;
      if (trailerRef) void pauseTrailerPlayback();
      else void pausePlayback();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && queueOpen) {
        queueOpen = false;
        return;
      }
      if (event.key === 'Escape' && trailerRef) {
        void closeTrailer();
        return;
      }
      if (event.key === 'Escape' && theaterMode) {
        toggleTheater(false);
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, button')) return;
      if (trailerRef) {
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
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (seekTimer !== null) window.clearTimeout(seekTimer);
      if (playerUiTimer !== null) window.clearTimeout(playerUiTimer);
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
    const hasActivePlayer = Boolean(current) && activeView === 'player';
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

  function formatTime(seconds = 0): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = Math.floor(seconds % 60);
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
      : `${minutes}:${String(remainder).padStart(2, '0')}`;
  }

  function readableTitle(filename: string): string {
    return filename
      .replace(/\.[^.]+$/, '')
      .replace(/^\[[^\]]+\]\s*/, '')
      .replace(/[._]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
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
    if (!isTauri() || !mpvReady) return;
    const margins = currentVideoMargins();
    if (!margins) return;
    await runWithMpv(() => setVideoMarginRatio(margins, MPV_WINDOW_LABEL));
  }

  function updateTrailerPlayback(patch: Partial<TrailerPlaybackState>) {
    if (!trailerRef) return;
    const next = { ...trailerRef, ...patch };
    trailerRef = next;
    trailerPlayback = next;
  }

  function isSupportedTrailerUrl(value: string): boolean {
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

  async function playTrailer(request: TrailerPlaybackRequest) {
    if (!isTauri() || trailerRef || trailerStartPromise) return;
    const generation = ++trailerOperationGeneration;

    if (currentRef && !playback.paused) await pausePlayback();
    trailerResume = currentRef
      ? { torrent: currentRef, playback: { ...playback, paused: true } }
      : null;
    trailerReplacedMedia = false;

    const initial: TrailerPlaybackState = {
      ...request,
      loading: true,
      ready: false,
      error: '',
      paused: true,
      time: 0,
      duration: 0,
      volume: playback.volume,
      muted: playback.muted
    };
    trailerRef = initial;
    trailerPlayback = initial;

    const operation = (async () => {
      try {
        if (!isSupportedTrailerUrl(request.url)) {
          throw new Error('This trailer provider is not supported by the desktop player.');
        }
        const nextRuntime = runtime ?? (await callBackend<RuntimeInfo>('runtime_info'));
        runtime = nextRuntime;
        if (!nextRuntime.mpvAvailable) {
          throw new Error('The bundled in-process video engine is unavailable.');
        }
        if (!nextRuntime.trailerAvailable) {
          throw new Error('The bundled YouTube trailer resolver is unavailable.');
        }
        if (generation !== trailerOperationGeneration || !trailerRef) return;

        await ensureMpv();
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        if (generation !== trailerOperationGeneration || !trailerRef) return;
        await syncVideoViewport();

        trailerReplacedMedia = true;
        await runWithMpv(async () => {
          await setProperty('speed', 1, MPV_WINDOW_LABEL);
          await mpvCommand('loadfile', [request.url, 'replace'], MPV_WINDOW_LABEL);
          await setProperty('pause', false, MPV_WINDOW_LABEL);
        });
      } catch (reason) {
        if (generation !== trailerOperationGeneration || !trailerRef) return;
        updateTrailerPlayback({
          loading: false,
          ready: false,
          paused: true,
          error: reason instanceof Error ? reason.message : String(reason)
        });
      }
    })();
    trailerStartPromise = operation;
    try {
      await operation;
    } finally {
      if (trailerStartPromise === operation) trailerStartPromise = null;
    }
  }

  async function closeTrailer() {
    if (!trailerRef && !trailerStartPromise) return;
    ++trailerOperationGeneration;
    const pendingStart = trailerStartPromise;
    if (pendingStart) await pendingStart.catch(() => undefined);

    const resume = trailerResume;
    const replacedMedia = trailerReplacedMedia;
    restoringEpisode = replacedMedia;
    trailerRef = null;
    trailerPlayback = null;
    trailerResume = null;
    trailerReplacedMedia = false;

    try {
      if (isTauri() && replacedMedia) {
        const sameTorrent =
          resume &&
          currentRef &&
          resume.torrent.id === currentRef.id &&
          resume.torrent.fileId === currentRef.fileId;
        if (sameTorrent && resume) {
          const streamUrl = await callBackend<string>('stream_url', {
            id: resume.torrent.id,
            fileId: resume.torrent.fileId
          });
          const episodeUrl = `${streamUrl}/${encodeURIComponent(resume.torrent.video.name)}`;
          await runWithMpv(async () => {
            await mpvCommand('loadfile', [episodeUrl, 'replace'], MPV_WINDOW_LABEL);
            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline) {
              const path = await getProperty<string | null>(
                'path',
                'string',
                MPV_WINDOW_LABEL
              ).catch(() => null);
              if (path?.startsWith(streamUrl)) break;
              await new Promise((resolve) => window.setTimeout(resolve, 100));
            }
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
            await setProperty('pause', true, MPV_WINDOW_LABEL);
          });
          playback = { ...resume.playback, paused: true };
        } else {
          await runWithMpv(() => mpvCommand('stop', [], MPV_WINDOW_LABEL));
        }
      }
    } catch (reason) {
      phase = 'error';
      error = `The episode could not be restored after the trailer: ${reason instanceof Error ? reason.message : String(reason)}`;
    } finally {
      restoringEpisode = false;
      window.requestAnimationFrame(() => {
        if (activeView === 'player') {
          void syncVideoViewport();
        } else if (isTauri() && mpvReady) {
          void runWithMpv(() =>
            setVideoMarginRatio({ left: 0, right: 0, top: 1, bottom: 0 }, MPV_WINDOW_LABEL)
          ).catch(() => undefined);
        }
      });
    }
  }

  async function toggleTrailerPlayback() {
    if (!trailerRef?.ready) return;
    const paused = !trailerRef.paused;
    updateTrailerPlayback({ paused });
    await runWithMpv(() => setProperty('pause', paused, MPV_WINDOW_LABEL));
  }

  async function pauseTrailerPlayback() {
    if (!trailerRef || trailerRef.paused) return;
    updateTrailerPlayback({ paused: true });
    await runWithMpv(() => setProperty('pause', true, MPV_WINDOW_LABEL)).catch(() => undefined);
  }

  async function seekTrailerRelative(seconds: number) {
    if (!trailerRef?.ready) return;
    const target = Math.max(0, Math.min(trailerRef.duration, trailerRef.time + seconds));
    updateTrailerPlayback({ time: target });
    await runWithMpv(() =>
      mpvCommand('seek', [target, 'absolute+exact'], MPV_WINDOW_LABEL).then(() => undefined)
    );
  }

  async function seekTrailerAbsolute(percent: number) {
    if (!trailerRef?.ready || trailerRef.duration <= 0) return;
    const target = (Math.max(0, Math.min(100, percent)) / 100) * trailerRef.duration;
    updateTrailerPlayback({ time: target });
    await runWithMpv(() =>
      mpvCommand('seek', [target, 'absolute+exact'], MPV_WINDOW_LABEL).then(() => undefined)
    );
  }

  async function changeTrailerVolume(volume: number) {
    if (!trailerRef) return;
    updateTrailerPlayback({ volume, muted: false });
    await runWithMpv(() => setProperty('mute', false, MPV_WINDOW_LABEL));
    await runWithMpv(() => setProperty('volume', volume, MPV_WINDOW_LABEL));
  }

  async function toggleTrailerMute() {
    if (!trailerRef) return;
    const muted = !trailerRef.muted;
    updateTrailerPlayback({ muted });
    await runWithMpv(() => setProperty('mute', muted, MPV_WINDOW_LABEL));
  }

  function onMpvProperty(event: MpvEventFromProperties<(typeof OBSERVED_PROPERTIES)[number]>) {
    if (restoringEpisode) return;
    if (trailerRef) {
      if (event.name === 'pause') updateTrailerPlayback({ paused: Boolean(event.data) });
      else if (event.name === 'time-pos') {
        updateTrailerPlayback({ time: Number(event.data ?? 0) });
      } else if (event.name === 'duration') {
        updateTrailerPlayback({ duration: Number(event.data ?? 0) });
      } else if (event.name === 'volume') {
        updateTrailerPlayback({ volume: Number(event.data ?? 0) });
      } else if (event.name === 'mute') {
        updateTrailerPlayback({ muted: Boolean(event.data) });
      } else if (event.name === 'media-title') {
        updateTrailerPlayback({
          mediaTitle: typeof event.data === 'string' ? event.data : undefined
        });
      } else if (event.name === 'paused-for-cache') {
        if (Boolean(event.data)) updateTrailerPlayback({ loading: true });
        else if (trailerRef.ready) updateTrailerPlayback({ loading: false });
      }
      return;
    }
    if (event.name === 'track-list') {
      tracks = normalizeTracks(event.data);
      return;
    }
    if (event.name === 'pause') playback = { ...playback, paused: Boolean(event.data) };
    else if (event.name === 'time-pos') playback = { ...playback, time: Number(event.data ?? 0) };
    else if (event.name === 'duration') playback = { ...playback, duration: Number(event.data ?? 0) };
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
        if (isSeeking) return;
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
            slang: 'nld,eng,jpn',
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
      mpvEventUnlisten = await listenEvents((event) => {
        if (restoringEpisode) return;
        if (trailerRef) {
          if (event.event === 'start-file') {
            updateTrailerPlayback({ loading: true, ready: false, error: '' });
          } else if (event.event === 'playback-restart') {
            updateTrailerPlayback({ loading: false, ready: true, error: '' });
          } else if (event.event === 'end-file' && event.reason === 'error') {
            updateTrailerPlayback({
              loading: false,
              ready: false,
              paused: true,
              error: 'This trailer could not be opened. YouTube may have changed its playback requirements.'
            });
          } else if (event.event === 'end-file') {
            updateTrailerPlayback({ loading: false, paused: true });
          }
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
      }, MPV_WINDOW_LABEL);

      const margins = currentVideoMargins();
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

  async function openTorrentStream(target: CurrentTorrent, attempt: number) {
    const streamUrl = await callBackend<string>('stream_url', {
      id: target.id,
      fileId: target.fileId
    });
    const url = `${streamUrl}/${encodeURIComponent(target.video.name)}`;
    await runWithMpv(async () => {
      const margins = currentVideoMargins();
      if (margins) await setVideoMarginRatio(margins, MPV_WINDOW_LABEL);
      await mpvCommand('loadfile', [url, 'replace'], MPV_WINDOW_LABEL);
      await setProperty('pause', false, MPV_WINDOW_LABEL);
    });
    await waitForPlaybackStart(streamUrl, attempt);
  }

  async function waitForPlaybackStart(streamUrl: string, attempt: number) {
    const deadline = Date.now() + PLAYBACK_START_TIMEOUT_MS;
    let verifiedPath = false;
    while (attempt === streamAttemptGeneration && Date.now() < deadline) {
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
      if (attempt !== streamAttemptGeneration) return;
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
    if (attempt !== streamAttemptGeneration) return;
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
    if (seekTimer !== null) window.clearTimeout(seekTimer);
    seekTimer = null;
    current = null;
    playingEpisode = null;
    stats = null;
    tracks = [];
    isSeeking = false;
    seekTarget = null;
    seekCacheDuration = 0;
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
      error = 'The bundled libmpv runtime is missing. Reinstall Yoru Stream or run the libmpv setup step.';
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
    saveSettings({ preferredQuality: quality });
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
    const index = libraryEntries.findIndex((entry) => entry.slug === (details.slug || show.page));
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
    const slug = details.slug || show.page;
    const existing = libraryEntries.find((entry) => entry.slug === slug);
    if (existing) {
      if (existing.following) {
        if (existing.discoveryVerdict) {
          commitLibrary(
            libraryEntries.map((entry) =>
              entry.slug === slug
                ? { ...entry, following: false, updatedAt: new Date().toISOString() }
                : entry
            )
          );
        } else {
          commitLibrary(libraryEntries.filter((entry) => entry.slug !== slug));
        }
      } else {
        commitLibrary(
          libraryEntries.map((entry) =>
            entry.slug === slug
              ? { ...entryFromShow(details, show, day, entry), following: true }
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
    const slug = details.slug || show.page;
    const index = libraryEntries.findIndex((entry) => entry.slug === slug);
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
    activeView = 'player';
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
      (entry) => entry.slug === playingEpisode?.slug && entry.following
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

  function loadSubsPleaseShow(slug: string, timezone: string) {
    return callBackend<SubsPleaseShowResponse>('subsplease_show', { slug, timezone });
  }

  function searchAniList(query: string) {
    return callBackend<AniListSearchResult[]>('anilist_search', { query });
  }

  async function togglePlayback() {
    if (!current) return;
    if (isTauri()) {
      const actuallyPaused = await runWithMpv(() =>
        getProperty<boolean>('pause', 'flag', MPV_WINDOW_LABEL)
      ).catch(() => playback.paused);
      const paused = !actuallyPaused;
      await runWithMpv(() => setProperty('pause', paused, MPV_WINDOW_LABEL));
      playback = { ...playback, paused };
    } else {
      playback = { ...playback, paused: !playback.paused };
    }
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
      if (activeView === 'player' && current && !queueOpen) playerUiVisible = false;
    }, 5_000);
  }

  function toggleTheater(force?: boolean) {
    theaterMode = force ?? !theaterMode;
    revealPlayerUi();
    window.setTimeout(() => void syncVideoViewport(), 120);
  }

  function togglePlayingEpisodeWatched(watched: boolean) {
    if (!playingEpisode || !playingLibraryEntry || watched === playingEpisodeWatched) return;
    setEpisodeWatched(playingEpisode.slug, playingEpisode.episode, watched);
  }

  function scheduleSeek(time: number) {
    if (!current) return;
    const target = Math.max(0, Math.min(playback.duration, time));
    pendingSeekTime = target;
    seekTarget = target;
    if (seekTimer !== null) window.clearTimeout(seekTimer);
    seekTimer = window.setTimeout(() => void flushScheduledSeek(), SEEK_DEBOUNCE_MS);
  }

  function seekRelative(seconds: number) {
    if (!current) return;
    scheduleSeek((pendingSeekTime ?? seekTarget ?? playback.time) + seconds);
  }

  function seekAbsolute(percent: number) {
    if (!current) return;
    scheduleSeek((percent / 100) * playback.duration);
  }

  function seekFromTrackClick(event: MouseEvent) {
    if (!current || !playback.duration || event.detail === 0) return;
    const track = event.currentTarget as HTMLElement;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;
    const percent = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100));
    seekAbsolute(percent);
  }

  async function flushScheduledSeek() {
    if (seekTimer !== null) {
      window.clearTimeout(seekTimer);
      seekTimer = null;
    }
    const target = pendingSeekTime;
    pendingSeekTime = null;
    if (target === null || !current) return;

    if (!isTauri()) {
      playback = { ...playback, time: target };
      seekTarget = null;
      return;
    }

    const generation = ++seekGeneration;
    isSeeking = true;
    seekCacheDuration = 0;
    try {
      await runWithMpv(() =>
        mpvCommand('seek', [target, 'absolute+keyframes'], MPV_WINDOW_LABEL).then(() => undefined)
      );
      const deadline = Date.now() + SEEK_BUFFER_TIMEOUT_MS;
      while (generation === seekGeneration && Date.now() < deadline) {
        const [seeking, cacheDuration] = await Promise.all([
          runWithMpv(() => getProperty<boolean>('seeking', 'flag', MPV_WINDOW_LABEL)),
          runWithMpv(() =>
            getProperty<number | null>('demuxer-cache-duration', 'double', MPV_WINDOW_LABEL)
          )
        ]);
        const bufferedSeconds = Math.max(0, Number(cacheDuration ?? 0));
        seekCacheDuration = bufferedSeconds;
        if (!seeking && bufferedSeconds >= SEEK_BUFFER_SECONDS) break;
        await new Promise((resolve) => window.setTimeout(resolve, 150));
      }
      if (generation !== seekGeneration) return;
    } catch (reason) {
      if (generation === seekGeneration) {
        error = `Seek could not be completed: ${reason instanceof Error ? reason.message : String(reason)}`;
      }
    } finally {
      if (generation === seekGeneration) {
        isSeeking = false;
        seekTarget = null;
        seekCacheDuration = 0;
        if (mpvPausedForCache) {
          bufferingStartedAt = Date.now();
          phase = 'buffering';
          armBufferingWatchdog();
        }
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

  async function toggleFullscreen() {
    if (!isTauri()) return;
    const appWindow = getCurrentWindow();
    await appWindow.setFullscreen(!(await appWindow.isFullscreen()));
    window.setTimeout(() => void syncVideoViewport(), 120);
  }

  async function selectTrack(type: 'sid' | 'aid', value: string) {
    const propertyValue = value === 'no' ? 'no' : Number(value);
    const numericId = propertyValue === 'no' ? undefined : propertyValue;
    tracks = tracks.map((track) => {
      const matchesType = type === 'sid' ? track.type === 'sub' : track.type === 'audio';
      return matchesType ? { ...track, selected: track.id === numericId } : track;
    });
    if (isTauri()) {
      await runWithMpv(() =>
        setProperty(type, propertyValue, MPV_WINDOW_LABEL)
      );
    }
  }

  async function retryPlayback() {
    if (!current) return;
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

<div class="grid h-screen min-h-0 overflow-hidden text-(--text) {theaterMode ? 'grid-rows-[minmax(0,1fr)]' : 'grid-rows-[4rem_minmax(0,1fr)]'}">
  {#if !theaterMode}
  <header class="grid grid-cols-[1fr_auto_1fr] items-center gap-4 border-b border-(--text)/8 bg-(--bg) px-4" data-tauri-drag-region>
    <div class="flex min-w-0 items-center gap-2 px-2" data-tauri-drag-region>
      <span class="grid size-8 place-items-center rounded-full bg-(--text) text-(--bg)"><Play class="size-3.5" fill="currentColor" /></span>
      <strong class="text-sm tracking-[0.16em]">YORU</strong><span class="text-sm text-(--text)/38">STREAM</span>
    </div>

    <Tabs bind:value={activeView} class="min-w-0 justify-self-center">
      <TabsList>
        <TabsTrigger value="player" class="gap-2"><MonitorPlay class="size-4" /> Player</TabsTrigger>
        <TabsTrigger value="library" class="gap-2"><BookOpen class="size-4" /> Library</TabsTrigger>
        <TabsTrigger value="discovery" class="gap-2"><Sparkles class="size-4" /> Discovery</TabsTrigger>
        <TabsTrigger value="subsplease" class="gap-2"><CalendarDays class="size-4" /> SubsPlease</TabsTrigger>
      </TabsList>
    </Tabs>

    <Button
      variant="ghost"
      size="icon"
      class={`justify-self-end ${activeView === 'account' ? 'bg-(--text)/10 text-(--text)' : ''}`}
      aria-label="Account settings"
      aria-current={activeView === 'account' ? 'page' : undefined}
      onclick={() => (activeView = 'account')}
    ><CircleUserRound class="size-5" /></Button>
  </header>
  {/if}

  <div class="relative min-h-0 overflow-hidden">
  <div class="h-full min-h-0 {trailerPlayback ? 'invisible pointer-events-none' : ''}">
  {#if activeView === 'library'}
    <LibraryPage
      entries={libraryEntries}
      loadShow={loadSubsPleaseShow}
      onPlay={playSubsPleaseRelease}
      onBrowse={() => (activeView = 'discovery')}
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
      loadSchedule={loadSubsPleaseSchedule}
      loadShow={loadSubsPleaseShow}
      libraryEntries={libraryEntries}
      onDecide={setDiscoveryVerdict}
      onOpenLibrary={() => (activeView = 'library')}
      onPlayTrailer={playTrailer}
    />
  {:else if activeView === 'subsplease'}
    <SubsPleasePage
      loadSchedule={loadSubsPleaseSchedule}
      loadShow={loadSubsPleaseShow}
      searchAnime={searchAniList}
      onPlay={playSubsPleaseRelease}
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
    <AccountSettingsPage {preferredQuality} onQualityChange={updatePreferredQuality} />
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
            <div class="grid size-full place-items-center">
              <Card class="border-0 bg-(--bg-elevated)/90"><CardContent class="flex min-w-72 flex-col items-center gap-3 p-8 text-center"><Spinner class="size-9" /><h2 class="font-medium">Preparing episode</h2><p class="text-sm text-(--text)/45">Setting up the stream…</p></CardContent></Card>
            </div>
          {:else if !current && phase === 'error'}
            <div class="grid size-full place-items-center p-6">
              <Alert variant="destructive" class="max-w-md"><AlertCircle class="size-5" /><AlertTitle>Episode could not start</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>
            </div>
          {/if}

          {#if current && phase === 'buffering'}
            <Card class="absolute left-1/2 top-6 z-30 -translate-x-1/2 border-0 bg-(--bg-elevated)/92 shadow-xl backdrop-blur-xl">
              <CardContent class="flex items-center gap-3 p-3 pr-4"><Spinner class="size-4" /><span class="flex min-w-36 flex-col"><strong class="text-xs">{waitingForPeers ? 'Waiting for peers' : 'Building buffer'}</strong><small class="text-[10px] text-(--text)/42">{waitingForPeers ? 'Trackers and DHT are still searching' : downloadSpeed > 0 ? stats?.live?.download_speed.human_readable : 'Opening video track and MKV header'}</small></span>{#if waitingForPeers}<Button variant="ghost" size="sm" onclick={() => void retryPlayback()}>Retry</Button>{/if}</CardContent>
            </Card>
          {/if}

          {#if current && isSeeking && phase === 'ready'}
            <Card class="absolute left-1/2 top-6 z-30 -translate-x-1/2 border-0 bg-(--bg-elevated)/92 shadow-xl backdrop-blur-xl" role="status" aria-live="polite">
              <CardContent class="flex items-center gap-3 p-3 pr-4"><Spinner class="size-4" /><span class="flex flex-col"><strong class="text-xs">Filling seek buffer · {formatTime(displayedPlaybackTime)}</strong><small class="text-[10px] text-(--text)/42">{seekCacheDuration >= 0.1 ? `${seekCacheDuration.toFixed(1)}s buffered ahead` : 'Downloading new torrent pieces'}</small></span></CardContent>
            </Card>
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
                <div class="pointer-events-auto flex min-w-0 items-start gap-3 rounded-2xl p-1 pr-3">
                  <button type="button" class="h-14 w-10 shrink-0 overflow-hidden rounded-lg bg-white/10 text-left hover:ring-2 hover:ring-white/25" aria-label={`Back to the details page for ${playingEpisode.title}`} onclick={returnToShowDetails}>
                    {#if playingEpisode.imageUrl}<img class="size-full object-cover" src={posterUrl(playingEpisode.imageUrl)} alt="" />{/if}
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
                <Badge class="bg-white/12 text-white">{playingEpisode?.quality ? `${playingEpisode.quality}p` : 'Auto'} · {bitrateLabel}</Badge>
                {#if theaterMode}
                  <Button variant="ghost" size="icon" class="pointer-events-auto bg-black/25 text-white hover:bg-white/15 hover:text-white" aria-label="Close theater mode" onclick={() => toggleTheater(false)}><X class="size-4" /></Button>
                {/if}
              </div>
            </div>
            <div class="absolute inset-x-0 bottom-0 z-20 space-y-3 bg-gradient-to-t from-black/95 via-black/60 to-transparent px-5 pb-4 pt-16 text-white transition-opacity duration-300 {playerUiVisible ? 'opacity-100' : 'pointer-events-none opacity-0'}" onclick={(event) => event.stopPropagation()} role="presentation">
              <div class="grid grid-cols-[3rem_minmax(0,1fr)_3rem] items-center gap-3 text-xs text-white/55">
                <span>{formatTime(displayedPlaybackTime)}</span>
                <Slider type="single" value={displayedPlaybackProgress} max={100} step={0.05} aria-label="Playback position" class="[&_[data-slot=slider-track]]:bg-white/20 [&_[data-slot=slider-range]]:bg-white [&_[data-slot=slider-thumb]]:bg-white" onValueCommit={(value) => seekAbsolute(Number(value))} onclick={seekFromTrackClick} />
                <span class="text-right">{formatTime(playback.duration)}</span>
              </div>
              <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-1">
                  <Button variant="ghost" size="icon" class="text-white hover:bg-white/10 hover:text-white" aria-label="Back 10 seconds" onclick={() => seekRelative(-10)}><Rewind class="size-4" /></Button>
                  <Button size="icon" class="size-11 bg-white text-black hover:bg-white/85" aria-label={playback.paused ? 'Play' : 'Pause'} onclick={() => void togglePlayback()}>{#if playback.paused}<Play class="size-5" fill="currentColor" />{:else}<Pause class="size-5" fill="currentColor" />{/if}</Button>
                  <Button variant="ghost" size="icon" class="text-white hover:bg-white/10 hover:text-white" aria-label="Forward 10 seconds" onclick={() => seekRelative(10)}><FastForward class="size-4" /></Button>
                  <Button variant="ghost" size="icon" class="text-white hover:bg-white/10 hover:text-white" aria-label={playback.muted ? 'Unmute' : 'Mute'} onclick={() => void toggleMute()}>{#if playback.muted}<VolumeX class="size-4" />{:else}<Volume2 class="size-4" />{/if}</Button>
                  <Slider type="single" value={playback.muted ? 0 : playback.volume} max={100} step={1} aria-label="Volume" class="hidden w-24 sm:flex [&_[data-slot=slider-track]]:bg-white/20 [&_[data-slot=slider-range]]:bg-white [&_[data-slot=slider-thumb]]:bg-white" onValueChange={(value) => void changeVolume(Number(value))} />
                </div>
                <div class="flex items-center gap-1">
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
                  <Button variant="ghost" size="icon" class="text-white hover:bg-white/10 hover:text-white" aria-label={theaterMode ? 'Close theater mode' : 'Open theater mode'} aria-pressed={theaterMode} onclick={() => toggleTheater()}><Theater class="size-4" /></Button>
                  <Button variant="ghost" size="icon" class="text-white hover:bg-white/10 hover:text-white" aria-label="Full screen" onclick={() => void toggleFullscreen()}><Maximize class="size-4" /></Button>
                </div>
              </div>
            </div>
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
    <main class="absolute inset-0 min-h-0 {trailerPlayback.ready && isTauri() ? 'bg-transparent' : 'bg-black'}">
      <section
        bind:this={trailerViewport}
        class="video-surface relative size-full min-h-0 overflow-hidden"
        class:live={trailerPlayback.ready}
        aria-label="Trailer player"
      >
        {#if trailerPlayback.ready}
          <Button
            variant="ghost"
            class="absolute inset-0 z-0 h-auto w-full rounded-none bg-transparent hover:bg-transparent"
            aria-label={trailerPlayback.paused ? 'Play trailer' : 'Pause trailer'}
            onclick={() => void toggleTrailerPlayback()}
          ></Button>
        {/if}

        {#if trailerPlayback.loading}
          <div class="absolute inset-0 z-20 grid place-items-center bg-black text-white">
            <div class="text-center"><Spinner class="mx-auto size-9 border-white/20 border-t-white" /><p class="mt-4 text-sm text-white/65">Opening trailer…</p></div>
          </div>
        {:else if trailerPlayback.error}
          <div class="absolute inset-0 z-20 grid place-items-center bg-black p-6">
            <Alert variant="destructive" class="max-w-lg"><AlertCircle class="size-5" /><AlertTitle>Trailer could not start</AlertTitle><AlertDescription>{trailerPlayback.error}</AlertDescription><Button variant="ghost" size="sm" class="mt-3" onclick={() => void closeTrailer()}>Back to Discovery</Button></Alert>
          </div>
        {/if}

        {#if trailerPlayback.ready && trailerPlayback.paused}
          <Button size="icon" class="absolute left-1/2 top-1/2 z-10 size-16 -translate-x-1/2 -translate-y-1/2 bg-white text-black shadow-xl hover:bg-white/85" aria-label="Play trailer" onclick={() => void toggleTrailerPlayback()}><Play class="size-7" fill="currentColor" /></Button>
        {/if}

        <div class="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start gap-4 bg-gradient-to-b from-black/80 to-transparent p-5 text-white">
          <div class="min-w-0 flex-1"><span class="text-[10px] uppercase tracking-[0.16em] text-white/50">Discovery trailer</span><h2 class="mt-1 max-w-3xl truncate font-medium">{trailerPlayback.mediaTitle || trailerPlayback.title}</h2></div>
          <Button variant="ghost" size="icon" class="pointer-events-auto bg-black/25 text-white hover:bg-white/15 hover:text-white" aria-label="Close trailer" onclick={() => void closeTrailer()}><X class="size-4" /></Button>
        </div>

        {#if trailerPlayback.ready}
          <div class="absolute inset-x-0 bottom-0 z-20 space-y-3 bg-gradient-to-t from-black/95 via-black/60 to-transparent px-5 pb-4 pt-16 text-white" onclick={(event) => event.stopPropagation()} role="presentation">
            <div class="grid grid-cols-[3rem_minmax(0,1fr)_3rem] items-center gap-3 text-xs text-white/55">
              <span>{formatTime(trailerPlayback.time)}</span>
              <Slider type="single" value={trailerPlaybackProgress} max={100} step={0.05} aria-label="Trailer playback position" class="[&_[data-slot=slider-track]]:bg-white/20 [&_[data-slot=slider-range]]:bg-white [&_[data-slot=slider-thumb]]:bg-white" onValueCommit={(value) => void seekTrailerAbsolute(Number(value))} />
              <span class="text-right">{formatTime(trailerPlayback.duration)}</span>
            </div>
            <div class="flex items-center justify-between gap-3">
              <div class="flex items-center gap-1">
                <Button variant="ghost" size="icon" class="text-white hover:bg-white/10 hover:text-white" aria-label="Back 10 seconds" onclick={() => void seekTrailerRelative(-10)}><Rewind class="size-4" /></Button>
                <Button size="icon" class="size-11 bg-white text-black hover:bg-white/85" aria-label={trailerPlayback.paused ? 'Play trailer' : 'Pause trailer'} onclick={() => void toggleTrailerPlayback()}>{#if trailerPlayback.paused}<Play class="size-5" fill="currentColor" />{:else}<Pause class="size-5" fill="currentColor" />{/if}</Button>
                <Button variant="ghost" size="icon" class="text-white hover:bg-white/10 hover:text-white" aria-label="Forward 10 seconds" onclick={() => void seekTrailerRelative(10)}><FastForward class="size-4" /></Button>
                <Button variant="ghost" size="icon" class="text-white hover:bg-white/10 hover:text-white" aria-label={trailerPlayback.muted ? 'Unmute trailer' : 'Mute trailer'} onclick={() => void toggleTrailerMute()}>{#if trailerPlayback.muted}<VolumeX class="size-4" />{:else}<Volume2 class="size-4" />{/if}</Button>
                <Slider type="single" value={trailerPlayback.muted ? 0 : trailerPlayback.volume} max={100} step={1} aria-label="Trailer volume" class="hidden w-24 sm:flex [&_[data-slot=slider-track]]:bg-white/20 [&_[data-slot=slider-range]]:bg-white [&_[data-slot=slider-thumb]]:bg-white" onValueChange={(value) => void changeTrailerVolume(Number(value))} />
              </div>
              <Button variant="ghost" size="icon" class="text-white hover:bg-white/10 hover:text-white" aria-label="Full screen" onclick={() => void toggleFullscreen()}><Maximize class="size-4" /></Button>
            </div>
          </div>
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
