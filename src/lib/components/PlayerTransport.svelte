<script lang="ts">
  import type { Snippet } from 'svelte';
  import {
    FastForward,
    Maximize,
    Minimize,
    PanelTopClose,
    PanelTopOpen,
    Pause,
    Play,
    Rewind,
    Volume2,
    VolumeX
  } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { Slider } from '$lib/components/ui/slider';

  type BufferedRange = {
    start: number;
    end: number;
  };

  let {
    currentTime,
    duration,
    progress,
    paused,
    muted,
    volume,
    theaterMode,
    fullscreenMode,
    visible = true,
    bufferedRanges = [],
    playbackLabel = 'Playback',
    onTogglePlayback,
    onSeekRelative,
    onSeekAbsolute,
    onToggleMute,
    onChangeVolume,
    onToggleTheater,
    onToggleFullscreen,
    secondaryControls
  }: {
    currentTime: number;
    duration: number;
    progress: number;
    paused: boolean;
    muted: boolean;
    volume: number;
    theaterMode: boolean;
    fullscreenMode: boolean;
    visible?: boolean;
    bufferedRanges?: BufferedRange[];
    playbackLabel?: string;
    onTogglePlayback: () => void | Promise<void>;
    onSeekRelative: (seconds: number) => void | Promise<void>;
    onSeekAbsolute: (percent: number) => void | Promise<void>;
    onToggleMute: () => void | Promise<void>;
    onChangeVolume: (volume: number) => void | Promise<void>;
    onToggleTheater: () => void | Promise<void>;
    onToggleFullscreen: () => void | Promise<void>;
    secondaryControls?: Snippet;
  } = $props();

  const TIMELINE_STEP = 0.05;

  function formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const rounded = Math.floor(seconds);
    const hours = Math.floor(rounded / 3600);
    const minutes = Math.floor((rounded % 3600) / 60);
    const remainder = rounded % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
      : `${minutes}:${String(remainder).padStart(2, '0')}`;
  }

  function normalizeTimelineValue(value: number): number {
    const clamped = Math.max(0, Math.min(100, value));
    const stepsPerPercent = 1 / TIMELINE_STEP;
    return Math.round(clamped * stepsPerPercent) / stepsPerPercent;
  }

  let timelineValue = $state(0);
  let scrubbing = $state(false);
  let displayedTime = $derived(
    scrubbing && duration > 0 ? (timelineValue / 100) * duration : currentTime
  );

  $effect(() => {
    if (!scrubbing) timelineValue = normalizeTimelineValue(progress);
  });

  function previewSeek(value: number) {
    timelineValue = normalizeTimelineValue(Number(value));
    scrubbing = true;
  }

  function commitSeek(value: number) {
    const target = normalizeTimelineValue(Number(value));
    timelineValue = target;
    void onSeekAbsolute(target);
    scrubbing = false;
  }
</script>

<div
  class="absolute inset-x-0 bottom-0 z-20 space-y-3 bg-gradient-to-t from-black/95 via-black/60 to-transparent px-5 pb-4 pt-16 text-white transition-opacity duration-300 {visible ? 'opacity-100' : 'pointer-events-none opacity-0'}"
  onclick={(event) => event.stopPropagation()}
  role="presentation"
>
  <div class="grid grid-cols-[3rem_minmax(0,1fr)_3rem] items-center gap-3 text-xs text-white/55">
    <span>{formatTime(displayedTime)}</span>
    <Slider
      type="single"
      value={timelineValue}
      {bufferedRanges}
      max={100}
      step={TIMELINE_STEP}
      aria-label={`${playbackLabel} position`}
      class="[&_[data-slot=slider-track]]:bg-white/20 [&_[data-slot=slider-buffer]]:bg-white/38 [&_[data-slot=slider-range]]:bg-white [&_[data-slot=slider-thumb]]:bg-white"
      onValueChange={(value) => previewSeek(Number(value))}
      onValueCommit={(value) => commitSeek(Number(value))}
    />
    <span class="text-right">{formatTime(duration)}</span>
  </div>

  <div class="flex items-center justify-between gap-3">
    <div class="flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon"
        class="text-white hover:bg-white/10 hover:text-white"
        aria-label="Back 10 seconds"
        onclick={() => void onSeekRelative(-10)}
      ><Rewind class="size-4" /></Button>
      <Button
        size="icon"
        class="size-11 bg-white text-black hover:bg-white/85"
        aria-label={paused ? `Play ${playbackLabel.toLowerCase()}` : `Pause ${playbackLabel.toLowerCase()}`}
        onclick={() => void onTogglePlayback()}
      >
        {#if paused}<Play class="size-5" fill="currentColor" />{:else}<Pause class="size-5" fill="currentColor" />{/if}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        class="text-white hover:bg-white/10 hover:text-white"
        aria-label="Forward 10 seconds"
        onclick={() => void onSeekRelative(10)}
      ><FastForward class="size-4" /></Button>
      <Button
        variant="ghost"
        size="icon"
        class="text-white hover:bg-white/10 hover:text-white"
        aria-label={muted ? 'Unmute' : 'Mute'}
        onclick={() => void onToggleMute()}
      >
        {#if muted}<VolumeX class="size-4" />{:else}<Volume2 class="size-4" />{/if}
      </Button>
      <Slider
        type="single"
        value={muted ? 0 : volume}
        max={100}
        step={1}
        aria-label="Volume"
        class="hidden shrink-0 sm:flex data-[orientation=horizontal]:w-32 lg:data-[orientation=horizontal]:w-40 [&_[data-slot=slider-track]]:bg-white/20 [&_[data-slot=slider-range]]:bg-white [&_[data-slot=slider-thumb]]:bg-white"
        onValueChange={(value) => void onChangeVolume(Number(value))}
      />
    </div>

    <div class="flex items-center gap-1">
      {@render secondaryControls?.()}
      <Button
        variant="ghost"
        size="icon"
        class="text-white hover:bg-white/10 hover:text-white"
        aria-label={theaterMode ? 'Close theater mode' : 'Open theater mode'}
        aria-pressed={theaterMode}
        onclick={() => void onToggleTheater()}
      >
        {#if theaterMode}
          <PanelTopOpen class="size-4" />
        {:else}
          <PanelTopClose class="size-4" />
        {/if}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        class="text-white hover:bg-white/10 hover:text-white"
        aria-label={fullscreenMode ? 'Exit full screen' : 'Full screen'}
        aria-pressed={fullscreenMode}
        onclick={() => void onToggleFullscreen()}
      >
        {#if fullscreenMode}<Minimize class="size-4" />{:else}<Maximize class="size-4" />{/if}
      </Button>
    </div>
  </div>
</div>
