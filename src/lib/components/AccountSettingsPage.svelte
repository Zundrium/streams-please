<script lang="ts">
  import { Check, MonitorCog, UserRound } from '@lucide/svelte';
  import type { PlaybackQuality } from '$lib/types';

  let {
    preferredQuality,
    onQualityChange
  }: {
    preferredQuality: PlaybackQuality;
    onQualityChange: (quality: PlaybackQuality) => void;
  } = $props();

  const qualities: Array<{
    value: PlaybackQuality;
    label: string;
    description: string;
  }> = [
    { value: '480', label: '480p', description: 'Data saver' },
    { value: '720', label: '720p', description: 'Balanced' },
    { value: '1080', label: '1080p', description: 'Best picture quality' }
  ];
</script>

<main class="h-full min-h-0 overflow-y-auto bg-(--bg) text-(--text)" aria-labelledby="account-title">
  <div class="mx-auto max-w-4xl px-5 pb-24 pt-14 lg:px-10 lg:pt-20">
    <header class="flex items-start gap-4 border-b border-(--text)/8 pb-10">
      <span class="grid size-14 shrink-0 place-items-center rounded-2xl bg-(--text) text-(--bg)">
        <UserRound class="size-6" />
      </span>
      <div>
        <p class="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-(--text)/35">Local profile</p>
        <h1 id="account-title" class="text-3xl font-semibold tracking-[-0.05em]">Account settings</h1>
        <p class="mt-2 max-w-xl text-sm leading-6 text-(--text)/45">Preferences for this app on this device. No online account is connected.</p>
      </div>
    </header>

    <section class="grid gap-8 py-10 md:grid-cols-[14rem_minmax(0,1fr)]" aria-labelledby="quality-title">
      <div>
        <span class="mb-3 grid size-9 place-items-center rounded-full bg-(--text)/6 text-(--text)/55"><MonitorCog class="size-4" /></span>
        <h2 id="quality-title" class="font-semibold">Preferred quality</h2>
        <p class="mt-2 text-sm leading-6 text-(--text)/42">This quality will be selected first when you start an episode.</p>
      </div>

      <div class="overflow-hidden rounded-3xl border border-(--text)/8 bg-(--bg-elevated)" role="radiogroup" aria-label="Preferred quality">
        {#each qualities as quality, index (quality.value)}
          <button
            type="button"
            role="radio"
            aria-checked={preferredQuality === quality.value}
            class="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-(--text)/4 {index ? 'border-t border-(--text)/8' : ''}"
            onclick={() => onQualityChange(quality.value)}
          >
            <span class="grid size-5 shrink-0 place-items-center rounded-full border {preferredQuality === quality.value ? 'border-chart-1 bg-chart-1 text-white' : 'border-(--text)/22 text-transparent'}">
              <Check class="size-3" />
            </span>
            <span class="flex min-w-0 flex-1 flex-col">
              <strong class="text-sm">{quality.label}</strong>
              <small class="mt-0.5 text-(--text)/40">{quality.description}</small>
            </span>
            {#if preferredQuality === quality.value}<span class="text-xs font-medium text-chart-1">Selected</span>{/if}
          </button>
        {/each}
      </div>
    </section>
  </div>
</main>
