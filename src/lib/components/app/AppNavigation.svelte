<script lang="ts">
  import { BookOpen, CalendarDays, CircleUserRound, MonitorPlay, Search, Sparkles, Users } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { Tabs, TabsList, TabsTrigger } from '$lib/components/ui/tabs';
  import StreamsPleaseLogo from '$lib/components/app/StreamsPleaseLogo.svelte';
  import TransferSpeeds from '$lib/components/app/TransferSpeeds.svelte';
  import WindowControls from '$lib/components/app/WindowControls.svelte';
  import logoUrl from '$lib/assets/logo.png';
  import { isTauri } from '$lib/backend';
  import type { AppView } from '$lib/types';

  let { activeView, onNavigate, roomActive, roomParticipants, onOpenRoom }: {
    activeView: AppView;
    onNavigate: (view: AppView) => void;
    roomActive: boolean;
    roomParticipants: number;
    onOpenRoom: () => void;
  } = $props();

  const views = [
    { id: 'player', label: 'Player', icon: MonitorPlay },
    { id: 'library', label: 'Library', icon: BookOpen },
    { id: 'search', label: 'Search', icon: Search },
    { id: 'discovery', label: 'Discovery', icon: Sparkles },
    { id: 'subsplease', label: 'SubsPlease', icon: CalendarDays }
  ] as const;
</script>

<header class="flex min-w-0 items-stretch gap-1 border-b border-(--text)/8 bg-(--bg) px-2 sm:gap-4 sm:px-4" data-tauri-drag-region>
  <div class="hidden shrink-0 items-center px-2 md:flex" data-tauri-drag-region>
    <span class="pointer-events-none flex select-none items-center gap-2.5">
      <img src={logoUrl} alt="" width="192" height="125" class="h-8 w-auto" draggable="false" />
      <span class="flex flex-col gap-1.5">
        <StreamsPleaseLogo />
        <TransferSpeeds />
      </span>
    </span>
  </div>
  <Tabs value={activeView} onValueChange={(value) => onNavigate(value as AppView)} class="h-full min-w-0">
    <TabsList class="h-full gap-0 rounded-none bg-transparent p-0" aria-label="Main navigation">
      {#each views as view (view.id)}
        <TabsTrigger value={view.id} aria-label={view.label}
          class="h-full gap-2 rounded-none border-b-2 border-transparent px-4 py-0 shadow-none data-[state=active]:border-(--text) data-[state=active]:bg-(--text)/4 data-[state=active]:shadow-none lg:px-5">
          <view.icon class="size-4" /><span class="hidden sm:inline">{view.label}</span>
        </TabsTrigger>
      {/each}
    </TabsList>
  </Tabs>
  <div class="min-w-0 flex-1" data-tauri-drag-region></div>
  <Button variant="ghost" size={roomParticipants ? 'default' : 'icon'}
    class={`my-auto shrink-0 gap-1.5 ${roomActive ? 'bg-(--text)/10 text-(--text)' : ''} ${roomParticipants ? 'px-3' : ''}`}
    aria-label={roomParticipants ? `Watch together, ${roomParticipants} in the room` : 'Watch together'} aria-haspopup="dialog"
    onclick={onOpenRoom}><Users class="size-5" />{#if roomParticipants}<span class="text-sm tabular-nums">{roomParticipants}</span>{/if}</Button>
  <Button variant="ghost" size="icon"
    class={`my-auto shrink-0 ${activeView === 'account' ? 'bg-(--text)/10 text-(--text)' : ''}`}
    aria-label="Account settings" aria-current={activeView === 'account' ? 'page' : undefined}
    onclick={() => onNavigate('account')}><CircleUserRound class="size-5" /></Button>
  {#if isTauri()}<WindowControls />{/if}
</header>
