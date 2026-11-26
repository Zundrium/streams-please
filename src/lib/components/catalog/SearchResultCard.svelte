<script lang="ts">
  import AnimePosterCard from '$lib/components/catalog/AnimePosterCard.svelte';
  import { CONFIRMED_MATCH_CONFIDENCE, preferredTitle, posterUrl, metadataLabel, type ProviderMatch } from '$lib/catalog';
  import type { AniListSearchResult } from '$lib/types';

  let { anime, match, verified, checking, onOpen }: {
    anime: AniListSearchResult;
    match?: ProviderMatch;
    verified: boolean;
    checking: boolean;
    onOpen: () => void;
  } = $props();
  const confirmed = $derived((match?.confidence ?? 0) >= CONFIRMED_MATCH_CONFIDENCE);
  const availability = $derived(match
    ? confirmed ? 'Available on SubsPlease' : 'Possible match · review details'
    : checking ? 'Checking availability…' : verified ? 'Not found on SubsPlease' : 'Availability unknown');
  const metadata = $derived([
    anime.format ? metadataLabel(anime.format) : '',
    anime.seasonYear,
    anime.episodes ? `${anime.episodes} episodes` : ''
  ].filter(Boolean).join(' · '));
</script>

<AnimePosterCard
  title={preferredTitle(anime)}
  imageUrl={posterUrl(anime.coverImage?.extraLarge ?? anime.coverImage?.large ?? '')}
  bottomLeft={availability}
  onOpen={match || !checking ? onOpen : undefined}
>
  {#snippet footer()}
    <p class="truncate text-xs text-(--text)/45">{metadata || 'Anime series'}</p>
    {#if match}
      <p class="mt-2 truncate text-xs text-(--text)/65" title={match.provider.title}>
        {confirmed ? 'SubsPlease' : 'Possible match'}: {match.provider.title}
      </p>
    {/if}
  {/snippet}
</AnimePosterCard>
