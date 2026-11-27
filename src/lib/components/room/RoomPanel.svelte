<script lang="ts">
  import { AlertCircle, Check, Copy, X } from '@lucide/svelte';
  import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert';
  import { Button } from '$lib/components/ui/button';
  import { Card, CardContent } from '$lib/components/ui/card';
  import { Input } from '$lib/components/ui/input';
  import { InputGroup, InputGroupAddon, InputGroupInput } from '$lib/components/ui/input-group';
  import { Label } from '$lib/components/ui/label';
  import { Spinner } from '$lib/components/ui/spinner';
  import { Switch } from '$lib/components/ui/switch';
  import RoomRoster from '$lib/components/room/RoomRoster.svelte';
  import { MAX_INVITE_LENGTH, MAX_NAME_LENGTH } from '$lib/room/protocol';
  import type { RoomCloseReason } from '$lib/room/protocol';
  import type { RoomSession } from '$lib/room/session.svelte';
  import { loadSettings, saveSettings } from '$lib/settings';

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
  const COPIED_FOR_MS = 2_000;

  let dialog = $state<HTMLDivElement | null>(null);
  let inviteField = $state<HTMLInputElement | null>(null);
  let name = $state(loadSettings().roomDisplayName ?? '');
  let invite = $state('');
  let copied = $state(false);
  let notice = $derived(room.error || (room.closeReason ? CLOSE_MESSAGES[room.closeReason] : ''));
  let eyebrow = $derived.by(() => {
    if (room.role === 'host') return `${room.roster.length} in the room`;
    if (room.role === 'guest') return `Hosted by ${room.hostName}`;
    return room.role === 'connecting' ? 'Connecting' : 'Not in a room';
  });

  $effect(() => {
    const previous = document.activeElement;
    dialog?.querySelector<HTMLElement>('input, button')?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  });

  $effect(() => {
    if (!copied) return;
    const timer = setTimeout(() => (copied = false), COPIED_FOR_MS);
    return () => clearTimeout(timer);
  });

  function host(): void {
    saveSettings({ roomDisplayName: name });
    void onHost(name);
  }

  function join(event: SubmitEvent): void {
    event.preventDefault();
    saveSettings({ roomDisplayName: name });
    void onJoin(invite, name);
  }

  async function copyInvite(): Promise<void> {
    try {
      await navigator.clipboard.writeText(room.invite);
      copied = true;
    } catch {
      inviteField?.focus();
      inviteField?.select();
    }
  }
</script>

<div
  bind:this={dialog}
  class="fixed inset-0 z-50 grid place-items-center bg-black/70 p-5 backdrop-blur-sm"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}
>
  <Card class="max-h-full w-full max-w-lg overflow-y-auto border-white/10 bg-(--bg-elevated) text-(--text) shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="room-title">
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
        <Button onclick={host}>Host a room</Button>
        <form class="flex flex-col gap-1.5" onsubmit={join}>
          <Label for="room-invite">Join with a code</Label>
          <div class="flex gap-2">
            <Input id="room-invite" bind:value={invite} maxlength={MAX_INVITE_LENGTH} placeholder="sproom1:…" autocomplete="off" spellcheck={false} aria-describedby="room-join-notice" />
            <Button type="submit" variant="ghost" disabled={!invite.trim()}>Join</Button>
          </div>
          <p id="room-join-notice" class="mt-1 text-xs leading-relaxed text-(--text)/50">
            The host chooses what plays. StreamsPlease downloads it over BitTorrent and seeds it like any other episode. The host can see your IP address.
          </p>
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
          <InputGroup>
            <InputGroupInput id="room-code" bind:ref={inviteField} value={room.invite} readonly spellcheck={false} onfocus={(event) => event.currentTarget.select()} />
            <InputGroupAddon align="inline-end">
              <Button variant="ghost" size="sm" onclick={() => void copyInvite()}>
                {#if copied}<Check />Copied{:else}<Copy />Copy{/if}
              </Button>
            </InputGroupAddon>
          </InputGroup>
          <span class="sr-only" role="status" aria-live="polite">{copied ? 'Invite code copied' : ''}</span>
        </div>
        <RoomRoster participants={room.roster} routes={room.routes} selfId={0} onRemove={room.remove} />
        {#if room.roster.length === 1}
          <p class="text-sm text-(--text)/50">Nobody has joined yet. Send the invite code to a friend.</p>
        {/if}
        <label class="flex items-center justify-between gap-3 text-sm">
          <span>
            Lock room
            <small class="block text-(--text)/45">Nobody new can join while the room is locked.</small>
          </span>
          <Switch checked={room.locked} aria-label="Lock room" onCheckedChange={(locked) => void room.setLocked(locked)} />
        </label>
        <div class="grid grid-cols-2 gap-2">
          <Button variant="ghost" disabled={!room.roomState?.media} onclick={room.stop}>Stop for everyone</Button>
          <Button variant="ghost" onclick={() => void room.leave()}>End room</Button>
        </div>
      {:else}
        {#if room.link === 'reconnecting'}
          <p class="flex items-center gap-3 text-sm text-(--text)/60" role="status" aria-live="polite"><Spinner class="size-4" />Reconnecting to the host</p>
        {/if}
        <RoomRoster participants={room.roster} routes={room.routes} selfId={room.selfId} />
        <Button variant="ghost" onclick={() => void room.leave()}>Leave room</Button>
      {/if}
    </CardContent>
  </Card>
</div>
