<script lang="ts">
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { Minus, Square, X } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';

  function minimizeWindow(): void {
    void getCurrentWindow().minimize();
  }

  function toggleMaximizeWindow(): void {
    void getCurrentWindow().toggleMaximize();
  }

  function closeWindow(): void {
    void getCurrentWindow().close();
  }
</script>

<div class="my-auto flex shrink-0 items-center gap-0.5 border-l border-(--text)/8 pl-3" role="toolbar" aria-label="Window controls">
  <Button
    variant="ghost"
    size="icon"
    class="size-9 rounded-xl bg-transparent text-(--text)/55 hover:bg-(--text)/8 hover:text-(--text) focus-visible:ring-2 focus-visible:ring-(--text)/24"
    aria-label="Minimize window"
    title="Minimize"
    onclick={minimizeWindow}
  >
    <Minus class="size-4" strokeWidth={1.75} />
  </Button>
  <Button
    variant="ghost"
    size="icon"
    class="size-9 rounded-xl bg-transparent text-(--text)/55 hover:bg-(--text)/8 hover:text-(--text) focus-visible:ring-2 focus-visible:ring-(--text)/24"
    aria-label="Maximize or restore window"
    title="Maximize or restore"
    onclick={toggleMaximizeWindow}
  >
    <Square class="size-3.5" strokeWidth={1.75} />
  </Button>
  <Button
    variant="ghost"
    size="icon"
    class="size-9 rounded-xl bg-transparent text-(--text)/55 hover:bg-red-500 hover:text-white focus-visible:ring-2 focus-visible:ring-red-500/40"
    aria-label="Close window"
    title="Close"
    onclick={closeWindow}
  >
    <X class="size-4" strokeWidth={1.75} />
  </Button>
</div>
