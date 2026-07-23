<script lang="ts">
  import { Check, Languages, MonitorCog, UserRound } from '@lucide/svelte';
  import ContextToolbar from '$lib/components/ContextToolbar.svelte';
  import type { PlaybackQuality, SubtitleLanguage } from '$lib/types';

  let {
    preferredQuality,
    preferredSubtitleLanguage,
    onQualityChange,
    onSubtitleLanguageChange
  }: {
    preferredQuality: PlaybackQuality;
    preferredSubtitleLanguage: SubtitleLanguage;
    onQualityChange: (quality: PlaybackQuality) => void;
    onSubtitleLanguageChange: (language: SubtitleLanguage) => void;
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

  const subtitleLanguages: Array<{
    value: SubtitleLanguage;
    label: string;
    description: string;
  }> = [
    { value: 'en', label: 'English', description: 'Default fallback language' },
    { value: 'ja', label: 'Japanese', description: 'Prefer Japanese captions' },
    { value: 'nl', label: 'Dutch', description: 'Prefer Dutch captions' }
  ];
</script>

<main class="h-full min-h-0 overflow-y-auto bg-(--bg) text-(--text)" aria-labelledby="account-title">
  <ContextToolbar class="justify-between">
    <div class="flex items-center gap-3">
      <span class="grid size-8 shrink-0 place-items-center rounded-full bg-(--text) text-(--bg)">
        <UserRound class="size-4" />
      </span>
      <h1 id="account-title" class="text-sm font-medium">Account settings</h1>
    </div>
    <p class="hidden text-xs text-(--text)/38 sm:block">Local preferences on this device</p>
  </ContextToolbar>

  <div class="mx-auto max-w-4xl px-5 pb-24 pt-10 lg:px-10">
    <section class="grid gap-8 md:grid-cols-[14rem_minmax(0,1fr)]" aria-labelledby="quality-title">
      <div class="text-reveal">
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

    <section class="mt-10 grid gap-8 border-t border-(--text)/8 pt-10 md:grid-cols-[14rem_minmax(0,1fr)]" aria-labelledby="subtitle-language-title">
      <div class="text-reveal">
        <span class="mb-3 grid size-9 place-items-center rounded-full bg-(--text)/6 text-(--text)/55"><Languages class="size-4" /></span>
        <h2 id="subtitle-language-title" class="font-semibold">Preferred episode subtitle language</h2>
        <p class="mt-2 text-sm leading-6 text-(--text)/42">Selected automatically for episode tracks when available. English is used when your preference is unavailable.</p>
      </div>

      <div class="overflow-hidden rounded-3xl border border-(--text)/8 bg-(--bg-elevated)" role="radiogroup" aria-label="Preferred episode subtitle language">
        {#each subtitleLanguages as language, index (language.value)}
          <button
            type="button"
            role="radio"
            aria-checked={preferredSubtitleLanguage === language.value}
            class="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-(--text)/4 {index ? 'border-t border-(--text)/8' : ''}"
            onclick={() => onSubtitleLanguageChange(language.value)}
          >
            <span class="grid size-5 shrink-0 place-items-center rounded-full border {preferredSubtitleLanguage === language.value ? 'border-chart-1 bg-chart-1 text-white' : 'border-(--text)/22 text-transparent'}">
              <Check class="size-3" />
            </span>
            <span class="flex min-w-0 flex-1 flex-col">
              <strong class="text-sm">{language.label}</strong>
              <small class="mt-0.5 text-(--text)/40">{language.description}</small>
            </span>
            {#if preferredSubtitleLanguage === language.value}<span class="text-xs font-medium text-chart-1">Selected</span>{/if}
          </button>
        {/each}
      </div>
    </section>
  </div>
</main>
