import { Channel } from '@tauri-apps/api/core';
import { callBackend } from '$lib/backend';
import type { UpdateCheckResult, UpdateDownloadEvent } from '$lib/types';

export function checkForUpdate(): Promise<UpdateCheckResult> {
  return callBackend<UpdateCheckResult>('check_for_update');
}

export async function installPendingUpdate(
  onEvent: (event: UpdateDownloadEvent) => void
): Promise<void> {
  const channel = new Channel<UpdateDownloadEvent>();
  channel.onmessage = onEvent;
  await callBackend<void>('install_update', { onEvent: channel });
}
