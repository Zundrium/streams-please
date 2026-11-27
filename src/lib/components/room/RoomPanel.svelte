<script lang="ts">
  import { AlertCircle, X } from '@lucide/svelte';
  import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import { Card, CardContent } from '$lib/components/ui/card';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Spinner } from '$lib/components/ui/spinner';
  import { MAX_INVITE_LENGTH, MAX_NAME_LENGTH } from '$lib/room/protocol';
  import type { Participant, RoomCloseReason } from '$lib/room/protocol';
  import type { RoomSession } from '$lib/room/session.svelte';

  let {
    room,
    onHost,
    onJoin,
    onClose
  }: {
    room: RoomSession;
    onHost: (name: string) => void | Promise<void>;
    onJoin: (invite: string, name: string) => void | Promise<void>;
    onClose: () => void;
  } = $props();

  const CLOSE_MESSAGES: Record<RoomCloseReason, string> = {
    ended: 'The host ended the room.',
    removed: 'The host removed you from the room.',
    full: 'The room is full.',
    locked: 'The host locked the room.',
    hostLost: 'The connection to the host was lost. Ask the host for a new invite code.',
    failed: 'The room stopped because of a connection problem. Host or join again.'
  };

  let name = $state('');
  let invite = $state('');
  let selfId = $derived(room.role === 'host' ? 0 : room.selfId);
  let notice = $derived(room.error || (room.closeReason ? CLOSE_MESSAGES[room.closeReason] : ''));
  let eyebrow = $derived.by(() => {
    if (room.role === 'host') return `${room.roster.length} in the room`;
    if (room.role === 'guest') return `Hosted by ${room.hostName}`;
    return room.role === 'connecting' ? 'Connecting' : 'Not in a room';
  });

  function phaseLabel(participant: Participant): string {
    const labels = { idle: 'Idle', loading: 'Loading', ready: 'Ready', away: 'Away', error: 'Error' };
    const progress =
      participant.phase === 'loading' && participant.progress !== null
        ? ` ${Math.round(participant.progress * 100)}%`
        : '';
    return `${labels[participant.phase]}${progress}${participant.blocking ? ' · holds the room' : ''}`;
  }

  function roleLabel(participant: Participant): string {
    return [participant.host ? 'Host' : '', participant.id === selfId ? 'You' : ''].filter(Boolean).join(' · ');
  }

  function join(event: SubmitEvent): void {
    event.preventDefault();
    void onJoin(invite, name);
  }
</script>

{#snippet roster()}
  <ul class="flex flex-col gap-1.5" aria-label="Participants" aria-live="polite">
    {#each room.roster as participant (participant.id)}
      <li class="flex items-center gap-3 rounded-2xl bg-(--text)/6 px-3 py-2 text-sm">
        <span class="min-w-0 flex-1 truncate">
          {participant.name}
          <small class="text-(--text)/45">{roleLabel(participant)}</small>
        </span>
        {#if room.routes[participant.id]}
          <small class="text-(--text)/45">{room.routes[participant.id] === 'direct' ? 'Direct' : 'Relayed'}</small>
        {/if}
        <Badge>{phaseLabel(participant)}</Badge>
      </li>
    {/each}
  </ul>
{/snippet}

<div
  class="fixed inset-0 z-50 grid place-items-center bg-black/70 p-5 backdrop-blur-sm"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}
>
  <Card class="w-full max-w-lg border-white/10 bg-(--bg-elevated) text-(--text) shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="room-title">
    <div class="flex items-center justify-between border-b border-(--text)/8 px-5 py-4">
      <div>
        <span class="text-[10px] uppercase tracking-[0.16em] text-(--text)/35">{eyebrow}</span>
        <h2 id="room-title" class="font-medium">Watch together</h2>
      </div>
      <Button variant="ghost" size="icon" class="size-9" aria-label="Close watch together" onclick={onClose}><X class="size-4" /></Button>
    </div>
    <CardContent class="gap-4 p-4">
      {#if notice}
        <Alert variant="destructive"><AlertCircle class="size-5" /><AlertTitle>{room.closeReason ? 'The room closed' : 'That did not work'}</AlertTitle><AlertDescription>{notice}</AlertDescription></Alert>
      {/if}

      {#if room.role === 'solo'}
        <div class="flex flex-col gap-1.5">
          <Label for="room-name">Your name</Label>
          <Input id="room-name" bind:value={name} maxlength={MAX_NAME_LENGTH} placeholder="Guest" autocomplete="off" />
        </div>
        <Button onclick={() => void onHost(name)}>Host a room</Button>
        <form class="flex flex-col gap-1.5" onsubmit={join}>
          <Label for="room-invite">Join with a code</Label>
          <div class="flex gap-2">
            <Input id="room-invite" bind:value={invite} maxlength={MAX_INVITE_LENGTH} placeholder="sproom1:…" autocomplete="off" spellcheck={false} />
            <Button type="submit" variant="ghost" disabled={!invite.trim()}>Join</Button>
          </div>
        </form>
      {:else if room.role === 'connecting'}
        <div class="flex items-center gap-3 text-sm" role="status" aria-live="polite">
          <Spinner class="size-5" />
          Connecting
        </div>
        <Button variant="ghost" onclick={() => void room.leave()}>Cancel</Button>
      {:else if room.role === 'host'}
        <div class="flex flex-col gap-1.5">
          <Label for="room-code">Invite code</Label>
          <Input id="room-code" value={room.invite} readonly spellcheck={false} onfocus={(event) => event.currentTarget.select()} />
        </div>
        {@render roster()}
        <Button variant="ghost" onclick={() => void room.leave()}>End room</Button>
      {:else}
        {#if room.link === 'reconnecting'}
          <p class="text-sm text-(--text)/60" role="status" aria-live="polite">Reconnecting to the host</p>
        {/if}
        {@render roster()}
        <Button variant="ghost" onclick={() => void room.leave()}>Leave room</Button>
      {/if}
    </CardContent>
  </Card>
</div>
