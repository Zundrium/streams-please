<script lang="ts">
  import { ChevronLeft, ChevronRight } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import type { AnimeSeason } from '$lib/types';

  let {
    season,
    year,
    current = false,
    canMoveNext = true,
    nextTitle = 'Next season',
    ariaLabel = 'Season',
    onPrevious,
    onNext
  }: {
    season: AnimeSeason;
    year: number;
    current?: boolean;
    canMoveNext?: boolean;
    nextTitle?: string;
    ariaLabel?: string;
    onPrevious: () => void;
    onNext: () => void;
  } = $props();

  let label = $derived(`${season[0]}${season.slice(1).toLowerCase()} ${year}`);
</script>

<nav class="flex shrink-0 items-center gap-1 sm:gap-2" aria-label={ariaLabel}>
  <Button variant="ghost" size="icon" aria-label="Previous season" onclick={onPrevious}>
    <ChevronLeft class="size-4" />
  </Button>
  <h1
    aria-current={current ? 'date' : undefined}
    class={`min-w-24 rounded-full px-2 py-2.5 text-center text-sm font-semibold transition-colors sm:min-w-40 sm:px-5 ${
      current ? 'bg-(--text) text-(--bg)' : 'text-(--text)/75'
    }`}
  >
    {label}
  </h1>
  <Button
    variant="ghost"
    size="icon"
    aria-label="Next season"
    title={nextTitle}
    disabled={!canMoveNext}
    onclick={onNext}
  >
    <ChevronRight class="size-4" />
  </Button>
</nav>
