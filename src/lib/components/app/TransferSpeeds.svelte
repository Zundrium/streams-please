<script lang="ts">
  import { ArrowDown, ArrowUp } from '@lucide/svelte';
  import { callBackend } from '$lib/backend';
  import { startPolling } from '$lib/async/polling';
  import { formatUploadSpeed, normalizeTransferSpeeds } from '$lib/torrent/seeding';

  const POLL_INTERVAL_MS = 1_000;

  let speeds = $state({ downloadMbps: 0, uploadMbps: 0 });

  $effect(() =>
    startPolling(async (isActive) => {
      const next = normalizeTransferSpeeds(await callBackend('transfer_speeds'));
      if (!isActive()) return false;
      speeds = next;
    }, POLL_INTERVAL_MS)
  );
</script>

<span
  class="flex items-center gap-2.5 text-[0.65rem] font-medium leading-none tabular-nums text-(--text)/50"
  aria-label={`Downloading at ${formatUploadSpeed(speeds.downloadMbps)}, uploading at ${formatUploadSpeed(speeds.uploadMbps)}`}
>
  <span class="flex min-w-[4.75rem] items-center gap-1"><ArrowDown class="size-3 shrink-0" strokeWidth={2.25} />{formatUploadSpeed(speeds.downloadMbps)}</span>
  <span class="flex min-w-[4.75rem] items-center gap-1"><ArrowUp class="size-3 shrink-0" strokeWidth={2.25} />{formatUploadSpeed(speeds.uploadMbps)}</span>
</span>
