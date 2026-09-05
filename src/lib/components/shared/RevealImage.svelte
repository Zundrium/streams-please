<script lang="ts">
  import type { HTMLImgAttributes } from 'svelte/elements';

  type Props = Omit<HTMLImgAttributes, 'src' | 'alt' | 'class' | 'onload' | 'onerror'> & {
    src: string;
    alt?: string;
    class?: string;
    reveal?: boolean;
  };

  let {
    src,
    alt = '',
    class: className = '',
    decoding = 'async',
    reveal = true,
    ...attributes
  }: Props = $props();

  let loadedSrc = $state('');
  let failedSrc = $state('');
  let loaded = $derived(Boolean(src) && loadedSrc === src);
  let ready = $derived(reveal && loaded);
  let failed = $derived(Boolean(src) && failedSrc === src);

  async function handleLoad(event: Event) {
    const image = event.currentTarget as HTMLImageElement;
    const expectedSrc = src;

    try {
      await image.decode();
    } catch {
      // Some webviews reject decode() after a successful load.
    }

    if (src === expectedSrc && image.naturalWidth > 0) {
      loadedSrc = expectedSrc;
      failedSrc = '';
    }
  }

  function handleError() {
    failedSrc = src;
    loadedSrc = '';
  }
</script>

<img
  {...attributes}
  {src}
  {alt}
  {decoding}
  class={`reveal-image ${className}`}
  data-image-state={ready ? 'ready' : failed ? 'error' : loaded ? 'waiting' : 'loading'}
  onload={handleLoad}
  onerror={handleError}
/>
