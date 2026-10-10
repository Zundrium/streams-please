export type PollTask = (isActive: () => boolean) => Promise<boolean | void>;

export function startPolling(task: PollTask, intervalMs: number): () => void {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const isActive = () => active;

  const tick = async () => {
    timer = null;
    const keepPolling = await task(isActive).catch(() => true);
    if (!active || keepPolling === false) return;
    timer = setTimeout(() => void tick(), intervalMs);
  };

  void tick();
  return () => {
    active = false;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
