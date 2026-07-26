import { callBackend, isTauri } from '$lib/backend';
import { MAX_LIBRARY_FILE_BYTES } from '$lib/library';

function backupFileName(): string {
  return `streamsplease-library-${new Date().toISOString().slice(0, 10)}.json`;
}

function sourceSize(contents: string): number {
  return new TextEncoder().encode(contents).byteLength;
}

function ensureFileSize(size: number): void {
  if (size > MAX_LIBRARY_FILE_BYTES) {
    throw new Error('The selected library file is too large.');
  }
}

function pickBrowserFile(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.hidden = true;

    const cleanup = () => input.remove();
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        cleanup();
        resolve(null);
        return;
      }
      try {
        ensureFileSize(file.size);
      } catch (reason) {
        cleanup();
        reject(reason);
        return;
      }
      void file.text().then(resolve, reject).finally(cleanup);
    }, { once: true });
    input.addEventListener('cancel', () => {
      cleanup();
      resolve(null);
    }, { once: true });
    document.body.append(input);
    input.click();
  });
}

function downloadBrowserFile(contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = backupFileName();
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function readLibraryFile(): Promise<string | null> {
  if (isTauri()) return callBackend<string | null>('import_library_file');
  return pickBrowserFile();
}

export async function writeLibraryFile(contents: string): Promise<boolean> {
  ensureFileSize(sourceSize(contents));
  if (isTauri()) {
    return callBackend<boolean>('export_library_file', { contents });
  }
  downloadBrowserFile(contents);
  return true;
}
