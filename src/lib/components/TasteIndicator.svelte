<script lang="ts">
  import { CircleHelp, Heart, Meh, ThumbsDown } from '@lucide/svelte';
  import { cn } from '$lib/utils';
  import type { DiscoveryVerdict } from '$lib/types';

  let {
    verdict,
    class: className,
    decorative = false
  }: {
    verdict?: DiscoveryVerdict;
    class?: string;
    decorative?: boolean;
  } = $props();

  let label = $derived(
    verdict === 'love'
      ? 'Love'
      : verdict === 'maybe'
        ? 'Looks okay'
        : verdict === 'pass'
          ? 'Not for me'
          : 'Not rated'
  );

  let colorClass = $derived(
    verdict === 'love'
      ? 'bg-chart-5 text-white'
      : verdict === 'maybe'
        ? 'bg-chart-3 text-white'
        : verdict === 'pass'
          ? 'bg-black/72 text-white'
          : 'bg-black/55 text-white/70'
  );
</script>

<span
  class={cn(
    'grid size-8 shrink-0 place-items-center rounded-full shadow-lg backdrop-blur-md',
    colorClass,
    className
  )}
  title={`Taste: ${label}`}
  role={decorative ? undefined : 'img'}
  aria-label={decorative ? undefined : `Taste: ${label}`}
  aria-hidden={decorative ? 'true' : undefined}
>
  {#if verdict === 'love'}
    <Heart class="size-4" fill="currentColor" />
  {:else if verdict === 'maybe'}
    <Meh class="size-4" />
  {:else if verdict === 'pass'}
    <ThumbsDown class="size-4" />
  {:else}
    <CircleHelp class="size-4" />
  {/if}
</span>
