<script lang="ts">
  import type { HTMLIframeAttributes } from 'svelte/elements';

  type Props = Omit<HTMLIframeAttributes, 'src' | 'class' | 'onload'> & {
    src: string;
    class?: string;
    reveal?: boolean;
  };

  let {
    src,
    class: className = '',
    reveal = true,
    ...attributes
  }: Props = $props();

  let loadedSrc = $state('');
  let loaded = $derived(Boolean(src) && loadedSrc === src);
  let ready = $derived(reveal && loaded);

  function handleLoad() {
    loadedSrc = src;
  }
</script>

<iframe
  {...attributes}
  {src}
  class={`reveal-frame ${className}`}
  data-frame-state={ready ? 'ready' : loaded ? 'waiting' : 'loading'}
  onload={handleLoad}
></iframe>
