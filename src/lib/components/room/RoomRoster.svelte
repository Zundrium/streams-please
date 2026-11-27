<script lang="ts">
  import { UserMinus } from '@lucide/svelte';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import type { Participant, ParticipantPhase, RoomRoute } from '$lib/room/protocol';

  let {
    participants,
    routes,
    selfId,
    onRemove
  }: {
    participants: Participant[];
    routes: Record<number, RoomRoute>;
    selfId: number;
    onRemove?: (id: number) => void | Promise<void>;
  } = $props();

  const PHASE_LABELS: Record<ParticipantPhase, string> = {
    idle: 'Idle',
    loading: 'Loading',
    ready: 'Ready',
    away: 'Away',
    error: 'Error'
  };

  function phaseLabel(participant: Participant): string {
    const progress =
      participant.phase === 'loading' && participant.progress !== null
        ? ` ${Math.round(participant.progress * 100)}%`
        : '';
    return `${PHASE_LABELS[participant.phase]}${progress}`;
  }

  function roleLabel(participant: Participant): string {
    return [participant.host ? 'Host' : '', participant.id === selfId ? 'You' : ''].filter(Boolean).join(' · ');
  }
</script>

<ul class="flex flex-col gap-1.5" aria-label="Participants" aria-live="polite">
  {#each participants as participant (participant.id)}
    <li class="flex min-h-12 items-center gap-3 rounded-2xl bg-(--text)/6 py-1.5 pl-3 pr-1.5 text-sm">
      <span class="min-w-0 flex-1 truncate">
        {participant.name}
        <small class="text-(--text)/45">{roleLabel(participant)}</small>
      </span>
      {#if routes[participant.id]}
        <small class="text-(--text)/45">{routes[participant.id] === 'direct' ? 'Direct' : 'Relayed'}</small>
      {/if}
      <Badge class={participant.blocking ? 'bg-(--text)/14 text-(--text)' : ''}>
        {phaseLabel(participant)}{participant.blocking ? ' · holds the room' : ''}
      </Badge>
      {#if onRemove && !participant.host}
        <Button variant="ghost" size="icon" class="size-9" aria-label={`Remove ${participant.name}`} onclick={() => void onRemove(participant.id)}><UserMinus class="size-4" /></Button>
      {:else if onRemove}
        <span class="size-9 shrink-0" aria-hidden="true"></span>
      {/if}
    </li>
  {/each}
</ul>
