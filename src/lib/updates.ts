import { Channel } from '@tauri-apps/api/core';
import { callBackend } from '$lib/backend';
import type { AppUpdateStatus, UpdateCheckResult, UpdateDownloadEvent } from '$lib/types';
import { errorMessage } from '$lib/errors';

export function checkForUpdate(): Promise<UpdateCheckResult> {
  return callBackend('check_for_update');
}

export async function installPendingUpdate(
  onEvent: (event: UpdateDownloadEvent) => void
): Promise<void> {
  const channel = new Channel<UpdateDownloadEvent>();
  channel.onmessage = onEvent;
  await callBackend('install_update', { onEvent: channel });
}

type AvailableUpdate = Extract<UpdateCheckResult, { status: 'available' }>;

type UpdateControllerOptions = {
  checkForUpdate: () => Promise<UpdateCheckResult>;
  installPendingUpdate: (onEvent: (event: UpdateDownloadEvent) => void) => Promise<void>;
  onStatusChange: (status: AppUpdateStatus | null) => void;
};

export function createUpdateController({
  checkForUpdate: check,
  installPendingUpdate: install,
  onStatusChange
}: UpdateControllerOptions) {
  let availableUpdate: AvailableUpdate | null = null;
  let operation: Promise<void> | null = null;
  let status: AppUpdateStatus | null = null;

  function setStatus(nextStatus: AppUpdateStatus | null) {
    status = nextStatus;
    onStatusChange(nextStatus);
  }

  function reportFailure(reason: unknown) {
    setStatus({
      phase: 'error',
      message: errorMessage(reason)
    });
  }

  async function performCheck() {
    availableUpdate = null;
    setStatus(null);
    try {
      const result = await check();
      if (result.status !== 'available') return;
      availableUpdate = result;
      setStatus({
        phase: 'available',
        version: result.version,
        currentVersion: result.currentVersion,
        notes: result.notes
      });
    } catch (reason) {
      reportFailure(reason);
    }
  }

  function updateDownloadProgress(event: UpdateDownloadEvent) {
    if (!status || status.phase !== 'downloading') return;
    if (event.event === 'started') {
      setStatus({ ...status, totalBytes: event.data.contentLength });
    } else if (event.event === 'progress') {
      setStatus({
        ...status,
        downloadedBytes: status.downloadedBytes + event.data.chunkLength
      });
    } else if (status.totalBytes) {
      setStatus({ ...status, downloadedBytes: status.totalBytes });
    }
  }

  async function performInstall(update: AvailableUpdate) {
    setStatus({
      phase: 'downloading',
      version: update.version,
      downloadedBytes: 0
    });
    try {
      await install(updateDownloadProgress);
    } catch (reason) {
      reportFailure(reason);
    }
  }

  function begin(action: () => Promise<void>): Promise<void> {
    if (operation) return operation;
    operation = action().finally(() => (operation = null));
    return operation;
  }

  return {
    check: () => begin(performCheck),
    accept: () => {
      const update = availableUpdate;
      return update ? begin(() => performInstall(update)) : Promise.resolve();
    }
  };
}
