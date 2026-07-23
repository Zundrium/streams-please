<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Film } from '@lucide/svelte';
  import RevealImage from '$lib/components/RevealImage.svelte';
  import TasteIndicator from '$lib/components/TasteIndicator.svelte';
  import type { DiscoveryVerdict } from '$lib/types';

  let {
    title,
    imageUrl = '',
    verdict,
    bottomLeft = '',
    bottomRight = '',
    notice = '',
    onOpen,
    posterOverlay,
    footer
  }: {
    title: string;
    imageUrl?: string;
    verdict?: DiscoveryVerdict;
    bottomLeft?: string;
    bottomRight?: string;
    notice?: string;
    onOpen: () => void;
    posterOverlay?: Snippet;
    footer?: Snippet;
  } = $props();
</script>

<article class="group relative min-w-0">
  <button
    type="button"
    class="card-open-button absolute inset-0 z-0 rounded-xl focus-visible:outline-none"
    aria-label={`Open ${title}`}
    onclick={onOpen}
  ></button>

  <div
    class="poster-frame pointer-events-none relative z-10 block aspect-[2/3] overflow-hidden rounded-xl bg-(--text)/5 ring-1 ring-white/6"
  >
    {#if imageUrl}
      <RevealImage
        src={imageUrl}
        alt=""
        loading="lazy"
        class="size-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.04]"
      />
    {:else}
      <span class="grid size-full place-items-center">
        <Film class="size-8 text-(--text)/22" />
      </span>
    {/if}

    <span class="absolute inset-x-0 bottom-0 {posterOverlay ? 'h-40' : 'h-24'} bg-gradient-to-t from-black/90 to-transparent"></span>

    {#if notice}
      <span class="absolute left-3 top-3 rounded-full bg-black/65 px-2.5 py-1 text-[10px] font-semibold text-white shadow-lg backdrop-blur-md">
        {notice}
      </span>
    {/if}

    <TasteIndicator
      {verdict}
      class="absolute right-3 top-3 z-10 size-7 [&_svg]:size-3.5"
    />

    <span class="absolute inset-x-3 {posterOverlay ? 'bottom-16' : 'bottom-3'} flex items-end justify-between gap-2 text-[10px] font-medium text-white/78">
      <span class="min-w-0 truncate">{bottomLeft}</span>
      <span class="min-w-0 truncate text-right">{bottomRight}</span>
    </span>

    {#if posterOverlay}
      <div class="pointer-events-auto absolute inset-x-0 bottom-0 z-20">
        {@render posterOverlay()}
      </div>
    {/if}
  </div>

  <h2 class="pointer-events-none relative z-10 line-clamp-2 mt-3 h-10 text-sm font-medium leading-5 lg:h-12 lg:text-base lg:leading-6">
    {title}
  </h2>

  {#if footer}
    <div class="relative z-10 mt-2">
      {@render footer()}
    </div>
  {/if}
</article>

<style>
  .card-open-button:focus-visible ~ .poster-frame {
    box-shadow: 0 0 0 2px var(--chart-1);
  }
</style>
