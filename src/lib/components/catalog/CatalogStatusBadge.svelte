<script lang="ts">
  import { Badge } from '$lib/components/ui/badge';
  import { catalogSourceLabel, type CatalogProvenance } from '$lib/catalog/providers';

  let { provenance, warning }: { provenance?: CatalogProvenance; warning?: string } = $props();
  const failed = $derived(provenance?.failedProviders?.join(', '));
  const label = $derived(failed
    ? `${failed} failed, showing ${provenance?.cache === 'stale' ? 'saved ' : ''}results of ${provenance?.label}`
    : warning ? 'Catalog coverage limited' : '');
  const details = $derived([catalogSourceLabel(provenance), warning].filter(Boolean).join(' · '));
</script>

{#if label}
  <Badge class="max-w-full whitespace-normal bg-(--text)/6 text-(--text)/60" title={details} tabindex={0} aria-label={`${label}. ${details}`}>
    {label}
  </Badge>
{/if}
