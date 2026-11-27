<script lang="ts">
  import { Users } from '@lucide/svelte';

  let { count, onOpen }: { count: number; onOpen: () => void } = $props();
</script>

<button
  type="button"
  class="pointer-events-auto flex h-7 items-center gap-1.5 rounded-full bg-white/10 px-3 text-[10px] font-medium text-white/82 backdrop-blur-sm transition-colors duration-150 hover:bg-white/20 focus-visible:bg-white/20 focus-visible:outline-none"
  aria-label={`Watch together, ${count} in the room`}
  aria-haspopup="dialog"
  onclick={onOpen}
>
  <Users class="size-3.5" />
  <span class="tabular-nums">{count}</span>
</button>
