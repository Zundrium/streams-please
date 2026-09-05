import { invoke } from '@tauri-apps/api/core';
import { callPreviewBackend, SINTEL_MAGNET } from '$lib/backend/preview';

export { SINTEL_MAGNET };

export type BackendCall = <T>(name: string, args?: Record<string, unknown>) => Promise<T>;

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function callBackend<T>(
  name: string,
  args?: Record<string, unknown>
): Promise<T> {
  if (isTauri()) return invoke<T>(name, args);
  return callPreviewBackend<T>(name, args);
}
