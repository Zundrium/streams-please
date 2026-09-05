<script lang="ts">
  import { Spinner } from '$lib/components/ui/spinner';
  import { cn } from '$lib/utils';

  let {
    label,
    class: className
  }: {
    label: string;
    class?: string;
  } = $props();
</script>

<section
  class={cn('grid min-h-[430px] place-items-center', className)}
  aria-busy="true"
  aria-live="polite"
  role="status"
>
  <div class="flex flex-col items-center gap-3 text-sm text-(--text)/45">
    <Spinner class="size-7" />
    <b class="text-(--text)/70">{label}</b>
  </div>
</section>
