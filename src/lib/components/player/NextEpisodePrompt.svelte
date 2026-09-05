<script lang="ts">
  import { Play, X } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { Card } from '$lib/components/ui/card';
  import { Spinner } from '$lib/components/ui/spinner';
  import RevealImage from '$lib/components/shared/RevealImage.svelte';

  let {
    title,
    episode,
    imageUrl,
    eyebrow = 'Up next',
    actionLabel = 'Watch next',
    busy = false,
    onDismiss,
    onWatch
  }: {
    title: string;
    episode: string;
    imageUrl: string;
    eyebrow?: string;
    actionLabel?: string;
    busy?: boolean;
    onDismiss: () => void;
    onWatch: () => void | Promise<void>;
  } = $props();
</script>

<aside
  class="next-episode-prompt pointer-events-auto absolute right-5 top-24 z-40 w-[calc(100%_-_2.5rem)] max-w-md"
  aria-labelledby="next-episode-title"
  aria-live="polite"
>
  <Card class="gap-0 overflow-hidden border border-white/12 bg-black/82 p-0 text-white shadow-2xl backdrop-blur-xl">
    <div class="grid grid-cols-[5.75rem_minmax(0,1fr)]">
      <div class="relative min-h-32 bg-white/6">
        {#if imageUrl}
          <RevealImage class="absolute inset-0 size-full object-cover" src={imageUrl} alt="" />
        {:else}
          <span class="grid size-full place-items-center"><Play class="size-6 text-white/28" /></span>
        {/if}
      </div>

      <div class="flex min-w-0 flex-col p-4">
        <span class="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/48">{eyebrow}</span>
        <h2 id="next-episode-title" class="mt-1 truncate text-sm font-semibold">{title}</h2>
        <p class="mt-1 text-xs text-white/58">Episode {episode}</p>

        <div class="mt-auto flex justify-end gap-2 pt-4">
          <Button
            variant="ghost"
            size="sm"
            class="gap-1.5 bg-white/8 text-white/68 hover:bg-white/12 hover:text-white"
            disabled={busy}
            onclick={onDismiss}
          ><X class="size-3.5" /> Dismiss</Button>
          <Button
            size="sm"
            class="gap-1.5 bg-white text-black hover:bg-white/85"
            disabled={busy}
            onclick={() => void onWatch()}
          >
            {#if busy}<Spinner class="size-3.5 border-black/20 border-t-black" />{:else}<Play class="size-3.5" fill="currentColor" />{/if}
            {actionLabel}
          </Button>
        </div>
      </div>
    </div>
  </Card>
</aside>

<style>
  .next-episode-prompt {
    animation: next-episode-enter 240ms ease-out;
  }

  @keyframes next-episode-enter {
    from {
      opacity: 0;
      transform: translateX(2rem);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .next-episode-prompt {
      animation: none;
    }
  }
</style>
