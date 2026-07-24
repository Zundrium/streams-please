<script lang="ts">
  import { Play, WavesHorizontal } from '@lucide/svelte';
</script>

<div class="flex shrink-0 items-center gap-2.5" role="img" aria-label="StreamsPlease">
  <span
    class="relative grid size-9 shrink-0 place-items-center overflow-hidden rounded-[0.7rem] border border-(--text)/12 bg-(--text) text-(--bg) shadow-sm"
    aria-hidden="true"
  >
    <WavesHorizontal class="absolute size-8 opacity-25" strokeWidth={1.5} />
    <Play class="relative ml-0.5 size-3.5" fill="currentColor" strokeWidth={2.25} />
  </span>
  <span class="grid gap-1 leading-none" aria-hidden="true">
    <strong class="text-[0.68rem] font-semibold tracking-[0.2em]">STREAMS</strong>
    <span class="text-[0.58rem] font-medium tracking-[0.34em] text-(--text)/45">PLEASE</span>
  </span>
</div>
