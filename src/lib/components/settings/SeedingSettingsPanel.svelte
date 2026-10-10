<script lang="ts">
  import { AlertCircle, ArrowUpFromLine, Check, Gauge, HardDrive, Share2, Trash2, Users } from '@lucide/svelte';
  import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import { InputGroup, InputGroupAddon, InputGroupInput } from '$lib/components/ui/input-group';
  import { Progress } from '$lib/components/ui/progress';
  import { Spinner } from '$lib/components/ui/spinner';
  import { callBackend } from '$lib/backend';
  import { startPolling } from '$lib/async/polling';
  import { errorMessage } from '$lib/catalog/presentation';
  import { formatBytes } from '$lib/torrent/media';
  import {
    KIB,
    MAX_UPLOAD_LIMIT_BPS,
    MIN_UPLOAD_LIMIT_BPS,
    SEEDING_RATIO_OPTIONS,
    UPLOAD_LIMIT_PRESETS_BPS,
    formatRatio,
    formatUploadLimit,
    formatUploadSpeed,
    normalizeSeedingOverview,
    percentOf,
    seedingDetail,
    seedingStatusLabel,
    uploadLimitFromKib
  } from '$lib/torrent/seeding';
  import type { SeedingEpisode, SeedingOverview } from '$lib/types';

  const POLL_INTERVAL_MS = 2_000;

  let overview = $state<SeedingOverview | null>(null);
  let loadError = $state('');
  let actionError = $state('');
  let ratioStatus = $state('');
  let savingRatio = $state<number | null>(null);
  let confirmingRemoval = $state('');
  let removing = $state('');
  let savingLimit = $state(false);
  let limitStatus = $state('');
  let customLimitKib = $state('');
  let customLimitError = $state('');

  let cachePercent = $derived(overview ? percentOf(overview.cacheUsedBytes, overview.cacheLimitBytes) : 0);
  let seedingCount = $derived(overview?.episodes.filter((episode) => episode.status === 'seeding').length ?? 0);

  $effect(() =>
    startPolling(async (isActive) => {
      try {
        const next = normalizeSeedingOverview(await callBackend('seeding_overview'));
        if (!isActive()) return false;
        overview = next;
        loadError = '';
      } catch (reason) {
        if (!isActive()) return false;
        loadError = errorMessage(reason);
      }
    }, POLL_INTERVAL_MS)
  );

  async function chooseRatio(ratio: number): Promise<void> {
    if (savingRatio !== null || overview?.targetRatio === ratio) return;
    savingRatio = ratio;
    actionError = '';
    try {
      overview = normalizeSeedingOverview(await callBackend('set_seeding_target_ratio', { ratio }));
      ratioStatus = `Episodes now seed until a ${formatRatio(ratio)} ratio.`;
    } catch (reason) {
      actionError = errorMessage(reason);
    } finally {
      savingRatio = null;
    }
  }

  async function removeEpisode(episode: SeedingEpisode): Promise<void> {
    if (confirmingRemoval !== episode.infoHash) {
      confirmingRemoval = episode.infoHash;
      return;
    }
    confirmingRemoval = '';
    removing = episode.infoHash;
    actionError = '';
    try {
      await callBackend('remove_torrent', { infoHash: episode.infoHash });
      overview = normalizeSeedingOverview(await callBackend('seeding_overview'));
    } catch (reason) {
      actionError = errorMessage(reason);
    } finally {
      removing = '';
    }
  }

  async function chooseUploadLimit(bytesPerSecond: number | null): Promise<void> {
    if (savingLimit || !overview) return;
    savingLimit = true;
    actionError = '';
    customLimitError = '';
    try {
      overview = normalizeSeedingOverview(
        await callBackend('set_seeding_upload_limit', { bytesPerSecond })
      );
      limitStatus = bytesPerSecond === null
        ? 'Uploads are no longer limited.'
        : `Uploads are now limited to ${formatUploadLimit(bytesPerSecond)}.`;
      if (bytesPerSecond === null || UPLOAD_LIMIT_PRESETS_BPS.some((preset) => preset === bytesPerSecond)) {
        customLimitKib = '';
      }
    } catch (reason) {
      actionError = errorMessage(reason);
    } finally {
      savingLimit = false;
    }
  }

  function applyCustomLimit(event: SubmitEvent): void {
    event.preventDefault();
    const bytesPerSecond = uploadLimitFromKib(Number(customLimitKib));
    if (customLimitKib.trim() === '' || bytesPerSecond === null) {
      customLimitError = `Enter a value between ${MIN_UPLOAD_LIMIT_BPS / KIB} and ${MAX_UPLOAD_LIMIT_BPS / KIB} KiB/s.`;
      return;
    }
    void chooseUploadLimit(bytesPerSecond);
  }

  function ratioLabel(ratio: number, defaultRatio: number): string {
    return ratio === defaultRatio ? 'Default' : ratio < defaultRatio ? 'Lighter sharing' : 'Give back more';
  }
</script>

<section class="grid gap-8 md:grid-cols-[14rem_minmax(0,1fr)]" aria-labelledby="cache-title">
  <div class="text-reveal">
    <span class="mb-3 grid size-9 place-items-center rounded-full bg-(--text)/6 text-(--text)/55"><HardDrive class="size-4" /></span>
    <h2 id="cache-title" class="font-semibold">Episode cache</h2>
    <p class="mt-2 text-sm leading-6 text-(--text)/42">Downloaded episodes stay on this device while they seed. When the cache is full, the least recently watched episodes are removed first.</p>
  </div>

  <div class="rounded-3xl border border-(--text)/8 bg-(--bg-elevated) p-5">
    {#if overview}
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <p class="text-sm"><strong class="text-2xl font-semibold tabular-nums">{formatBytes(overview.cacheUsedBytes)}</strong> <span class="text-(--text)/42">of {formatBytes(overview.cacheLimitBytes)}</span></p>
        <span class="text-xs text-(--text)/42 tabular-nums">{Math.round(cachePercent)}% used</span>
      </div>
      <Progress class="mt-3" value={cachePercent} max={100} aria-label="Episode cache usage" />
      <dl class="mt-5 grid grid-cols-2 gap-4 border-t border-(--text)/8 pt-5 sm:grid-cols-3">
        <div>
          <dt class="text-xs text-(--text)/42">Total uploaded</dt>
          <dd class="mt-1 text-sm font-medium tabular-nums">{formatBytes(overview.totalUploadedBytes)}</dd>
        </div>
        <div>
          <dt class="text-xs text-(--text)/42">Upload speed</dt>
          <dd class="mt-1 text-sm font-medium tabular-nums">{formatUploadSpeed(overview.uploadSpeedMbps)}</dd>
        </div>
        <div>
          <dt class="text-xs text-(--text)/42">Seeding now</dt>
          <dd class="mt-1 text-sm font-medium tabular-nums">{seedingCount} of {overview.episodes.length} {overview.episodes.length === 1 ? 'episode' : 'episodes'}</dd>
        </div>
      </dl>
    {:else if loadError}
      <p class="text-sm text-(--text)/55">Cache details are unavailable right now.</p>
    {:else}
      <div class="flex items-center gap-3 text-sm text-(--text)/45"><Spinner class="size-4" /> Loading cache details…</div>
    {/if}
  </div>
</section>

<section class="mt-10 grid gap-8 border-t border-(--text)/8 pt-10 md:grid-cols-[14rem_minmax(0,1fr)]" aria-labelledby="seeding-ratio-title">
  <div class="text-reveal">
    <span class="mb-3 grid size-9 place-items-center rounded-full bg-(--text)/6 text-(--text)/55"><Share2 class="size-4" /></span>
    <h2 id="seeding-ratio-title" class="font-semibold">Seeding ratio</h2>
    <p class="mt-2 text-sm leading-6 text-(--text)/42">Each fully downloaded episode keeps sharing until it has uploaded this multiple of its size, then it is removed.</p>
  </div>

  <div class="overflow-hidden rounded-3xl border border-(--text)/8 bg-(--bg-elevated)" role="radiogroup" aria-label="Seeding ratio">
    {#each SEEDING_RATIO_OPTIONS as ratio, index (ratio)}
      {@const selected = overview?.targetRatio === ratio}
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        disabled={!overview || savingRatio !== null}
        class="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-(--text)/4 disabled:cursor-default {index ? 'border-t border-(--text)/8' : ''}"
        onclick={() => void chooseRatio(ratio)}
      >
        <span class="grid size-5 shrink-0 place-items-center rounded-full border {selected ? 'border-chart-1 bg-chart-1 text-white' : 'border-(--text)/22 text-transparent'}">
          <Check class="size-3" />
        </span>
        <span class="flex min-w-0 flex-1 flex-col">
          <strong class="text-sm tabular-nums">{formatRatio(ratio)}×</strong>
          <small class="mt-0.5 text-(--text)/40">{ratioLabel(ratio, overview?.defaultTargetRatio ?? 1.5)}</small>
        </span>
        {#if savingRatio === ratio}<Spinner class="size-4" />{:else if selected}<span class="text-xs font-medium text-chart-1">Selected</span>{/if}
      </button>
    {/each}
  </div>
  <p class="sr-only" aria-live="polite">{ratioStatus}</p>
</section>

<section class="mt-10 grid gap-8 border-t border-(--text)/8 pt-10 md:grid-cols-[14rem_minmax(0,1fr)]" aria-labelledby="upload-limit-title">
  <div class="text-reveal">
    <span class="mb-3 grid size-9 place-items-center rounded-full bg-(--text)/6 text-(--text)/55"><Gauge class="size-4" /></span>
    <h2 id="upload-limit-title" class="font-semibold">Upload limit</h2>
    <p class="mt-2 text-sm leading-6 text-(--text)/42">The most StreamsPlease sends to peers per second, across all episodes. Downloads are not limited.</p>
  </div>

  <div class="rounded-3xl border border-(--text)/8 bg-(--bg-elevated) p-5">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <p class="text-sm"><strong class="text-2xl font-semibold tabular-nums">{overview ? formatUploadLimit(overview.uploadLimitBps) : '—'}</strong></p>
      {#if overview}<span class="text-xs text-(--text)/42 tabular-nums">Uploading at {formatUploadSpeed(overview.uploadSpeedMbps)}</span>{/if}
    </div>
    <div class="mt-4 flex flex-wrap gap-2" role="radiogroup" aria-label="Upload limit">
      {#each [null, ...UPLOAD_LIMIT_PRESETS_BPS] as limit (limit ?? 'unlimited')}
        {@const selected = overview?.uploadLimitBps === limit}
        <button
          type="button"
          role="radio"
          aria-checked={selected}
          disabled={!overview || savingLimit}
          class="h-9 rounded-full border px-4 text-sm tabular-nums transition-colors disabled:cursor-default {selected ? 'border-chart-1 bg-chart-1 text-white' : 'border-(--text)/12 hover:bg-(--text)/5 disabled:opacity-60'}"
          onclick={() => void chooseUploadLimit(limit)}
        >{formatUploadLimit(limit)}</button>
      {/each}
    </div>
    <form class="mt-5 flex flex-wrap items-start gap-2 border-t border-(--text)/8 pt-5" onsubmit={applyCustomLimit}>
      <label class="sr-only" for="custom-upload-limit">Custom upload limit in KiB per second</label>
      <InputGroup class="w-full max-w-56">
        <InputGroupInput
          id="custom-upload-limit"
          type="number"
          inputmode="numeric"
          min={MIN_UPLOAD_LIMIT_BPS / KIB}
          max={MAX_UPLOAD_LIMIT_BPS / KIB}
          step="1"
          placeholder="Custom"
          aria-invalid={customLimitError ? 'true' : undefined}
          aria-describedby={customLimitError ? 'custom-upload-limit-error' : undefined}
          disabled={!overview || savingLimit}
          bind:value={customLimitKib}
          oninput={() => (customLimitError = '')}
        />
        <InputGroupAddon align="inline-end" class="pe-4">KiB/s</InputGroupAddon>
      </InputGroup>
      <Button type="submit" variant="ghost" class="gap-2" disabled={!overview || savingLimit}>
        {#if savingLimit}<Spinner class="size-4" />{/if}Set limit
      </Button>
      {#if customLimitError}<p id="custom-upload-limit-error" class="basis-full text-xs text-red-600 dark:text-red-400">{customLimitError}</p>{/if}
    </form>
  </div>
  <p class="sr-only" aria-live="polite">{limitStatus}</p>
</section>

<section class="mt-10 grid gap-8 border-t border-(--text)/8 pt-10 md:grid-cols-[14rem_minmax(0,1fr)]" aria-labelledby="seeding-episodes-title">
  <div class="text-reveal">
    <span class="mb-3 grid size-9 place-items-center rounded-full bg-(--text)/6 text-(--text)/55"><ArrowUpFromLine class="size-4" /></span>
    <h2 id="seeding-episodes-title" class="font-semibold">Cached episodes</h2>
    <p class="mt-2 text-sm leading-6 text-(--text)/42">Live sharing statistics for every episode on this device. Totals carry over between app launches.</p>
  </div>

  <div class="min-w-0 space-y-3">
    {#if loadError}
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Could not load seeding stats</AlertTitle>
        <AlertDescription>{loadError}</AlertDescription>
      </Alert>
    {/if}
    {#if actionError}
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Action failed</AlertTitle>
        <AlertDescription>{actionError}</AlertDescription>
      </Alert>
    {/if}

    {#if !overview}
      {#if !loadError}
        <div class="flex items-center gap-3 rounded-3xl border border-(--text)/8 bg-(--bg-elevated) px-5 py-6 text-sm text-(--text)/45"><Spinner class="size-4" /> Loading episodes…</div>
      {/if}
    {:else if overview.episodes.length === 0}
      <div class="rounded-3xl border border-dashed border-(--text)/12 px-5 py-10 text-center">
        <HardDrive class="mx-auto size-6 text-(--text)/30" />
        <p class="mt-3 text-sm font-medium">No cached episodes</p>
        <p class="mt-1 text-xs text-(--text)/42">Episodes you watch appear here while they seed.</p>
      </div>
    {:else}
      <ul class="overflow-hidden rounded-3xl border border-(--text)/8 bg-(--bg-elevated)" aria-label="Cached episodes">
        {#each overview.episodes as episode, index (episode.infoHash)}
          {@const ratioPercent = percentOf(episode.ratio, overview.targetRatio)}
          <li class="px-5 py-4 {index ? 'border-t border-(--text)/8' : ''}">
            <div class="flex items-start gap-3">
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <strong class="min-w-0 truncate text-sm" title={episode.name}>{episode.name}</strong>
                  <Badge class={episode.status === 'seeding' || episode.status === 'streaming' ? 'bg-chart-1/12 text-chart-1' : episode.status === 'error' ? 'bg-red-500/10 text-red-600 dark:text-red-400' : ''}>{seedingStatusLabel(episode.status)}</Badge>
                </div>
                <p class="mt-1 text-xs leading-5 text-(--text)/42">{seedingDetail(episode, overview.targetRatio)}</p>
              </div>
              <Button
                variant={confirmingRemoval === episode.infoHash ? 'destructive' : 'ghost'}
                size={confirmingRemoval === episode.infoHash ? 'sm' : 'icon'}
                class={confirmingRemoval === episode.infoHash ? 'shrink-0 gap-2' : 'size-9 shrink-0 rounded-full'}
                aria-label={confirmingRemoval === episode.infoHash ? `Confirm removing ${episode.name}` : `Remove ${episode.name} from the cache`}
                title={episode.status === 'streaming' ? 'Stop playback before removing this episode' : 'Remove from cache'}
                disabled={episode.status === 'streaming' || removing !== ''}
                onclick={() => void removeEpisode(episode)}
                onblur={() => { if (confirmingRemoval === episode.infoHash) confirmingRemoval = ''; }}
              >
                {#if removing === episode.infoHash}<Spinner class="size-4" />{:else}<Trash2 class="size-4" />{/if}
                {#if confirmingRemoval === episode.infoHash}Remove{/if}
              </Button>
            </div>

            <div class="mt-3 flex items-center gap-3">
              <Progress class="h-1.5 flex-1" value={ratioPercent} max={100} aria-label={`Seeding ratio for ${episode.name}`} />
              <span class="w-24 shrink-0 text-right text-xs tabular-nums text-(--text)/55">{formatRatio(episode.ratio)} / {formatRatio(overview.targetRatio)}</span>
            </div>

            <dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
              <div>
                <dt class="text-(--text)/40">Uploaded</dt>
                <dd class="mt-0.5 tabular-nums">{formatBytes(episode.uploadedBytes)}</dd>
              </div>
              <div>
                <dt class="text-(--text)/40">Downloaded</dt>
                <dd class="mt-0.5 tabular-nums">{episode.downloadedBytes < episode.sizeBytes ? `${formatBytes(episode.downloadedBytes)} of ${formatBytes(episode.sizeBytes)}` : formatBytes(episode.sizeBytes)}</dd>
              </div>
              <div>
                <dt class="text-(--text)/40">Upload speed</dt>
                <dd class="mt-0.5 tabular-nums">{formatUploadSpeed(episode.uploadSpeedMbps)}</dd>
              </div>
              <div>
                <dt class="text-(--text)/40">Peers</dt>
                <dd class="mt-0.5 flex items-center gap-1 tabular-nums"><Users class="size-3 text-(--text)/40" />{episode.peers}</dd>
              </div>
            </dl>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>
