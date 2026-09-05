<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from '$lib/utils';

  let {
    children,
    overlay = false,
    class: className
  }: {
    children: Snippet;
    overlay?: boolean;
    class?: string;
  } = $props();
</script>

<header
  data-slot="context-toolbar"
  class={cn(
    'sticky top-0 z-40 flex h-16 shrink-0 items-center gap-2 border-b border-(--text)/8 bg-(--bg)/72 px-5 backdrop-blur-2xl lg:gap-4 lg:px-10',
    overlay && '-mb-16',
    className
  )}
>
  {@render children()}
</header>
