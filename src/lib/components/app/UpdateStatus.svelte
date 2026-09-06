<script lang="ts">
  import { AlertCircle, Download, RefreshCw, X } from '@lucide/svelte';
  import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert';
  import { Button } from '$lib/components/ui/button';
  import { Progress } from '$lib/components/ui/progress';
  import type { AppUpdateStatus } from '$lib/types';

  let {
    status,
    onAccept,
    onRetry,
    onDismiss
  }: {
    status: AppUpdateStatus;
    onAccept: () => void;
    onRetry: () => void;
    onDismiss: () => void;
  } = $props();

  let percentage = $derived(
    status.phase === 'downloading' && status.totalBytes
      ? Math.min(100, (status.downloadedBytes / status.totalBytes) * 100)
      : 0
  );

  function downloadedLabel(): string {
    if (status.phase !== 'downloading') return '';
    const downloaded = Math.round(status.downloadedBytes / 1_048_576);
    if (!status.totalBytes) return `${downloaded} MB downloaded`;
    return `${downloaded} of ${Math.round(status.totalBytes / 1_048_576)} MB`;
  }
</script>

<div class="fixed bottom-5 right-5 z-100 w-[min(24rem,calc(100vw-2.5rem))]" aria-live="polite">
  {#if status.phase === 'available'}
    <div class="rounded-3xl border border-(--text)/10 bg-(--bg-elevated) p-5 shadow-2xl">
      <div class="flex items-start gap-3">
        <span class="grid size-9 shrink-0 place-items-center rounded-full bg-(--text) text-(--bg)"><Download class="size-4" /></span>
        <span class="min-w-0 flex-1">
          <strong class="block text-sm">StreamsPlease {status.version} is available</strong>
          <small class="mt-1 block text-(--text)/45">You have {status.currentVersion}. Downloading and installing starts only after you agree.</small>
        </span>
      </div>
      {#if status.notes}
        <details class="mt-3 text-sm text-(--text)/65">
          <summary class="cursor-pointer text-(--text)/85">What’s new</summary>
          <p class="mt-2 whitespace-pre-wrap">{status.notes}</p>
        </details>
      {/if}
      <div class="mt-4 flex flex-wrap gap-2">
        <Button size="sm" class="gap-2" onclick={onAccept}><Download class="size-3.5" /> Download and install</Button>
        <Button variant="ghost" size="sm" onclick={onDismiss}>Later</Button>
      </div>
    </div>
  {:else if status.phase === 'downloading'}
    <div class="rounded-3xl border border-(--text)/10 bg-(--bg-elevated) p-5 shadow-2xl" role="status">
      <div class="flex items-start gap-3">
        <span class="grid size-9 shrink-0 place-items-center rounded-full bg-(--text) text-(--bg)"><Download class="size-4" /></span>
        <span class="min-w-0 flex-1">
          <strong class="block text-sm">Installing StreamsPlease {status.version}</strong>
          <small class="mt-1 block text-(--text)/45">{downloadedLabel()} · The app will restart automatically.</small>
        </span>
      </div>
      <Progress class="mt-4" value={percentage} aria-label="Update download progress" />
    </div>
  {:else}
    <Alert variant="destructive" class="pr-12 shadow-2xl">
      <AlertCircle class="size-4" />
      <AlertTitle>Update failed</AlertTitle>
      <AlertDescription>{status.message}</AlertDescription>
      <div class="mt-3 flex gap-2">
        <Button variant="ghost" size="sm" class="gap-2" onclick={onRetry}><RefreshCw class="size-3.5" /> Try again</Button>
      </div>
      <Button variant="ghost" size="icon" class="absolute right-2 top-2 size-8" aria-label="Dismiss update error" onclick={onDismiss}><X class="size-4" /></Button>
    </Alert>
  {/if}
</div>
