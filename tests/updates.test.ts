import assert from 'node:assert/strict';
import test from 'node:test';
import { createUpdateController } from '../src/lib/updates.ts';
import type { AppUpdateStatus, UpdateDownloadEvent } from '../src/lib/types.ts';

test('an available update waits for explicit acceptance before downloading', async () => {
  const statuses: Array<AppUpdateStatus | null> = [];
  let installCalls = 0;
  let onDownloadEvent: ((event: UpdateDownloadEvent) => void) | undefined;
  const controller = createUpdateController({
    checkForUpdate: async () => ({
      status: 'available',
      version: '0.2.0',
      currentVersion: '0.1.0',
      notes: 'Consent first'
    }),
    installPendingUpdate: async (onEvent) => {
      installCalls += 1;
      onDownloadEvent = onEvent;
    },
    onStatusChange: (status) => statuses.push(status)
  });

  await controller.check();

  assert.equal(installCalls, 0);
  assert.deepEqual(statuses.at(-1), {
    phase: 'available',
    version: '0.2.0',
    currentVersion: '0.1.0',
    notes: 'Consent first'
  });

  const accepted = controller.accept();
  onDownloadEvent?.({ event: 'started', data: { contentLength: 100 } });
  onDownloadEvent?.({ event: 'progress', data: { chunkLength: 25 } });
  await accepted;

  assert.equal(installCalls, 1);
  assert.deepEqual(statuses.at(-1), {
    phase: 'downloading',
    version: '0.2.0',
    downloadedBytes: 25,
    totalBytes: 100
  });
});

test('a failed install can be retried without bypassing consent', async () => {
  const statuses: Array<AppUpdateStatus | null> = [];
  let checks = 0;
  let installs = 0;
  const controller = createUpdateController({
    checkForUpdate: async () => {
      checks += 1;
      return { status: 'available', version: '0.2.0', currentVersion: '0.1.0' };
    },
    installPendingUpdate: async () => {
      installs += 1;
      throw new Error('Network interrupted');
    },
    onStatusChange: (status) => statuses.push(status)
  });

  await controller.check();
  await controller.accept();
  assert.deepEqual(statuses.at(-1), { phase: 'error', message: 'Network interrupted' });

  await controller.check();

  assert.equal(checks, 2);
  assert.equal(installs, 1);
  assert.equal(statuses.at(-1)?.phase, 'available');
});
