<script lang="ts">
  import { Film, TriangleAlert, Tv2 } from '@lucide/svelte';
  import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert';
  import { Button } from '$lib/components/ui/button';
  import { cn } from '$lib/utils';

  let {
    title,
    description = '',
    kind = 'empty',
    actionLabel = '',
    secondaryActionLabel = '',
    centered = false,
    class: className,
    onAction,
    onSecondaryAction
  }: {
    title: string;
    description?: string;
    kind?: 'empty' | 'warning' | 'error';
    actionLabel?: string;
    secondaryActionLabel?: string;
    centered?: boolean;
    class?: string;
    onAction?: () => void;
    onSecondaryAction?: () => void;
  } = $props();
</script>

{#if kind === 'empty'}
  <section
    class={cn(centered && 'grid min-h-[390px] place-items-center', className)}
    role="status"
  >
    <div class="max-w-md text-center">
      <span class="mx-auto grid size-14 place-items-center rounded-full bg-(--surface-strong)">
        <Film class="size-6 text-(--text)/28" />
      </span>
      <h2 class="mt-4 text-lg font-medium">{title}</h2>
      {#if description}
        <p class="mt-2 text-sm leading-6 text-(--text)/42">{description}</p>
      {/if}
      {#if actionLabel && onAction}
        <Button class="mt-5" onclick={onAction}>{actionLabel}</Button>
      {/if}
    </div>
  </section>
{:else}
  <Alert
    variant={kind === 'error' ? 'destructive' : 'default'}
    class={cn(centered && 'max-w-xl', className)}
  >
    {#if kind === 'error'}
      <Tv2 class="size-5" />
    {:else}
      <TriangleAlert class="size-5" />
    {/if}
    <AlertTitle>{title}</AlertTitle>
    {#if description}<AlertDescription>{description}</AlertDescription>{/if}
    {#if (actionLabel && onAction) || (secondaryActionLabel && onSecondaryAction)}
      <div class="mt-3 flex flex-wrap gap-2">
        {#if actionLabel && onAction}
          <Button variant="ghost" size="sm" onclick={onAction}>{actionLabel}</Button>
        {/if}
        {#if secondaryActionLabel && onSecondaryAction}
          <Button variant="ghost" size="sm" onclick={onSecondaryAction}>
            {secondaryActionLabel}
          </Button>
        {/if}
      </div>
    {/if}
  </Alert>
{/if}
