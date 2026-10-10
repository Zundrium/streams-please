import { invoke } from '@tauri-apps/api/core';
import { callPreviewBackend, SINTEL_MAGNET } from '$lib/backend/preview';
import type {
  BackendArgsTuple,
  BackendCall,
  BackendCommand,
  BackendResult
} from '$lib/backend/commands';

export { SINTEL_MAGNET };
export type { BackendCall, BackendCommand } from '$lib/backend/commands';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function callBackend<K extends BackendCommand>(
  name: K,
  ...args: BackendArgsTuple<K>
): Promise<BackendResult<K>> {
  if (isTauri()) return invoke<BackendResult<K>>(name, args[0]);
  return callPreviewBackend(name, ...args);
}

callBackend satisfies BackendCall;
