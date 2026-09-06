<script lang="ts">
  import { AlertCircle, Check, ChevronDown, ChevronUp, Database, Download, Languages, MonitorCog, Upload, UserRound } from '@lucide/svelte';
  import ContextToolbar from '$lib/components/shared/ContextToolbar.svelte';
  import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { createLibraryExport, parseLibraryExport } from '$lib/library';
  import { readLibraryFile, writeLibraryFile } from '$lib/library-transfer';
  import {
    CATALOG_PROVIDERS,
    loadSettings,
    normalizeMyAnimeListClientId,
    saveSettings,
    type CatalogProviderId
  } from '$lib/settings';
  import type {
    LibraryBackupEntry,
    LibraryEntry,
    PlaybackQuality,
    SubtitleLanguage
  } from '$lib/types';

  let {
    preferredQuality,
    preferredSubtitleLanguage,
    libraryEntries,
    onQualityChange,
    onSubtitleLanguageChange,
    onLibraryImport
  }: {
    preferredQuality: PlaybackQuality;
    preferredSubtitleLanguage: SubtitleLanguage;
    libraryEntries: LibraryEntry[];
    onQualityChange: (quality: PlaybackQuality) => void;
    onSubtitleLanguageChange: (language: SubtitleLanguage) => void;
    onLibraryImport: (entries: LibraryBackupEntry[]) => Promise<void>;
  } = $props();

  type TransferStatus = {
    kind: 'success' | 'error';
    title: string;
    description: string;
  };

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

  let transferOperation = $state<'export' | 'import' | null>(null);
  let transferStatus = $state<TransferStatus | null>(null);
  let catalogProviderOrder = $state<CatalogProviderId[]>(loadSettings().catalogProviderOrder);
  let catalogProviderStatus = $state('');
  let myAnimeListClientId = $state(loadSettings().myAnimeListClientId ?? '');
  let myAnimeListClientIdStatus = $state('');

  function moveCatalogProvider(provider: CatalogProviderId, direction: -1 | 1): void {
    const index = catalogProviderOrder.indexOf(provider);
    const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= catalogProviderOrder.length) return;
    const next = [...catalogProviderOrder];
    [next[index], next[destination]] = [next[destination], next[index]];
    catalogProviderOrder = next;
    catalogProviderStatus = `${CATALOG_PROVIDERS.find((item) => item.id === provider)?.label ?? provider} moved to position ${destination + 1}.`;
    saveSettings({ catalogProviderOrder: next });
  }

  function saveMyAnimeListClientId(): void {
    const trimmed = myAnimeListClientId.trim();
    const normalized = normalizeMyAnimeListClientId(trimmed);
    if (trimmed && !normalized) {
      myAnimeListClientIdStatus = 'Enter 8–128 letters, numbers, hyphens, or underscores.';
      return;
    }
    myAnimeListClientId = normalized ?? '';
    saveSettings({ myAnimeListClientId: normalized });
    myAnimeListClientIdStatus = normalized
      ? 'Official MyAnimeList requests are enabled on this device.'
      : 'Official MyAnimeList requests are disabled on this device.';
  }

  function errorMessage(reason: unknown): string {
    return reason instanceof Error ? reason.message : String(reason);
  }

  function showCount(count: number): string {
    return `${count} ${count === 1 ? 'show' : 'shows'}`;
  }

  async function exportLibrary() {
    transferOperation = 'export';
    transferStatus = null;
    try {
      const exported = await writeLibraryFile(createLibraryExport(libraryEntries));
      if (!exported) return;
      transferStatus = {
        kind: 'success',
        title: 'Library exported',
        description: `Saved ${showCount(libraryEntries.length)} and their watched progress.`
      };
    } catch (reason) {
      transferStatus = {
        kind: 'error',
        title: 'Could not export library',
        description: errorMessage(reason)
      };
    } finally {
      transferOperation = null;
    }
  }

  async function importLibrary() {
    transferOperation = 'import';
    transferStatus = null;
    try {
      const source = await readLibraryFile();
      if (source === null) return;
      const entries = parseLibraryExport(source);
      await onLibraryImport(entries);
      transferStatus = {
        kind: 'success',
        title: 'Library imported',
        description: `Refreshed and merged ${showCount(entries.length)} into your library.`
      };
    } catch (reason) {
      transferStatus = {
        kind: 'error',
        title: 'Could not import library',
        description: errorMessage(reason)
      };
    } finally {
      transferOperation = null;
    }
  }
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

    <section class="mt-10 grid gap-8 border-t border-(--text)/8 pt-10 md:grid-cols-[14rem_minmax(0,1fr)]" aria-labelledby="myanimelist-client-id-title">
      <div class="text-reveal">
        <span class="mb-3 grid size-9 place-items-center rounded-full bg-(--text)/6 text-(--text)/55"><Database class="size-4" /></span>
        <h2 id="myanimelist-client-id-title" class="font-semibold">Official MyAnimeList access</h2>
        <p class="mt-2 text-sm leading-6 text-(--text)/42">Use your public MyAnimeList app Client ID for the official catalog API.</p>
      </div>

      <form class="rounded-3xl border border-(--text)/8 bg-(--bg-elevated) p-5" onsubmit={(event) => { event.preventDefault(); saveMyAnimeListClientId(); }}>
        <label for="myanimelist-client-id" class="text-sm font-medium">MyAnimeList Client ID</label>
        <div class="mt-3 flex flex-col gap-3 sm:flex-row">
          <Input
            id="myanimelist-client-id"
            class="h-10 flex-1"
            autocomplete="off"
            spellcheck={false}
            placeholder="Public app identifier"
            bind:value={myAnimeListClientId}
            oninput={() => (myAnimeListClientIdStatus = '')}
            aria-describedby="myanimelist-client-id-help myanimelist-client-id-status"
          />
          <Button type="submit" class="self-start sm:self-auto">Save Client ID</Button>
        </div>
        <p id="myanimelist-client-id-help" class="mt-3 text-xs leading-5 text-(--text)/42">This is a public app identifier, not an OAuth secret. It stays only in this browser’s local settings and is sent only with official MyAnimeList requests.</p>
        <p id="myanimelist-client-id-status" class="mt-2 text-xs text-(--text)/55" aria-live="polite">{myAnimeListClientIdStatus}</p>
      </form>
    </section>

    <section class="mt-10 grid gap-8 border-t border-(--text)/8 pt-10 md:grid-cols-[14rem_minmax(0,1fr)]" aria-labelledby="catalog-provider-order-title">
      <div class="text-reveal">
        <span class="mb-3 grid size-9 place-items-center rounded-full bg-(--text)/6 text-(--text)/55"><Database class="size-4" /></span>
        <h2 id="catalog-provider-order-title" class="font-semibold">Catalog provider order</h2>
        <p class="mt-2 text-sm leading-6 text-(--text)/42">Try providers in this order when new catalog data is needed. Saved results remain available first.</p>
      </div>

      <ol class="overflow-hidden rounded-3xl border border-(--text)/8 bg-(--bg-elevated)" aria-label="Catalog provider order">
        {#each catalogProviderOrder as providerId, index (providerId)}
          {@const provider = CATALOG_PROVIDERS.find((item) => item.id === providerId)!}
          <li class="flex items-center gap-3 px-5 py-4 {index ? 'border-t border-(--text)/8' : ''}">
            <span class="grid size-7 shrink-0 place-items-center rounded-full bg-(--text)/5 text-xs font-medium text-(--text)/50" aria-hidden="true">{index + 1}</span>
            <span class="min-w-0 flex-1">
              <strong class="block text-sm">{provider.label}</strong>
              <small class="mt-0.5 block text-(--text)/40">{index === 0 ? 'First choice for new requests' : 'Fallback provider'}</small>
            </span>
            <span class="flex shrink-0 gap-1">
              <Button
                variant="ghost"
                size="icon"
                class="size-9 rounded-full"
                aria-label={`Move ${provider.label} up`}
                title={`Move ${provider.label} up`}
                disabled={index === 0}
                onclick={() => moveCatalogProvider(providerId, -1)}
              ><ChevronUp class="size-4" /></Button>
              <Button
                variant="ghost"
                size="icon"
                class="size-9 rounded-full"
                aria-label={`Move ${provider.label} down`}
                title={`Move ${provider.label} down`}
                disabled={index === catalogProviderOrder.length - 1}
                onclick={() => moveCatalogProvider(providerId, 1)}
              ><ChevronDown class="size-4" /></Button>
            </span>
          </li>
        {/each}
      </ol>
      <p class="sr-only" aria-live="polite">{catalogProviderStatus}</p>
    </section>

    <section class="mt-10 grid gap-8 border-t border-(--text)/8 pt-10 md:grid-cols-[14rem_minmax(0,1fr)]" aria-labelledby="library-data-title">
      <div class="text-reveal">
        <span class="mb-3 grid size-9 place-items-center rounded-full bg-(--text)/6 text-(--text)/55"><Database class="size-4" /></span>
        <h2 id="library-data-title" class="font-semibold">Library data</h2>
        <p class="mt-2 text-sm leading-6 text-(--text)/42">Back up show IDs and your watched progress to a compact JSON file.</p>
      </div>

      <div class="space-y-3">
        <div class="overflow-hidden rounded-3xl border border-(--text)/8 bg-(--bg-elevated)">
          <div class="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center">
            <span class="grid size-10 shrink-0 place-items-center rounded-full bg-(--text)/5 text-(--text)/55"><Download class="size-4" /></span>
            <span class="min-w-0 flex-1">
              <strong class="block text-sm">Export library</strong>
              <small class="mt-1 block leading-5 text-(--text)/40">Save show IDs, preferences, and watched progress.</small>
            </span>
            <Button
              variant="ghost"
              class="gap-2 self-start sm:self-auto"
              disabled={transferOperation !== null}
              onclick={() => void exportLibrary()}
            >
              <Download class="size-4" />
              {transferOperation === 'export' ? 'Exporting…' : 'Export JSON'}
            </Button>
          </div>

          <div class="flex flex-col gap-4 border-t border-(--text)/8 px-5 py-5 sm:flex-row sm:items-center">
            <span class="grid size-10 shrink-0 place-items-center rounded-full bg-(--text)/5 text-(--text)/55"><Upload class="size-4" /></span>
            <span class="min-w-0 flex-1">
              <strong class="block text-sm">Import library</strong>
              <small class="mt-1 block leading-5 text-(--text)/40">Refresh show details from AniList and SubsPlease, then merge watched progress.</small>
            </span>
            <Button
              variant="ghost"
              class="gap-2 self-start sm:self-auto"
              disabled={transferOperation !== null}
              onclick={() => void importLibrary()}
            >
              <Upload class="size-4" />
              {transferOperation === 'import' ? 'Importing…' : 'Import JSON'}
            </Button>
          </div>
        </div>

        {#if transferStatus}
          <Alert variant={transferStatus.kind === 'error' ? 'destructive' : 'default'}>
            {#if transferStatus.kind === 'error'}<AlertCircle />{:else}<Check />{/if}
            <AlertTitle>{transferStatus.title}</AlertTitle>
            <AlertDescription>{transferStatus.description}</AlertDescription>
          </Alert>
        {/if}
      </div>
    </section>
  </div>
</main>
