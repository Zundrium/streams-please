import { Generation } from '$lib/async/generation';
import { SerialQueue } from '$lib/async/serial-queue';
import { chooseVideoFile } from '$lib/torrent/media';
import type { AddTorrentResponse, CurrentTorrent } from '$lib/types';

export type TorrentBackend = {
  addMagnet: (magnet: string) => Promise<AddTorrentResponse>;
  forget: (id: number) => Promise<void>;
};

export type TorrentSessionHooks = {
  stopPlayback: (previous: CurrentTorrent) => Promise<void>;
  onCleared: () => void;
  onStarted: (torrent: CurrentTorrent) => Promise<void> | void;
};

export type TorrentStartResult =
  | { status: 'started'; torrent: CurrentTorrent }
  | { status: 'superseded' };

const SUPERSEDED: TorrentStartResult = { status: 'superseded' };

export class TorrentSession {
  private readonly backend: TorrentBackend;
  private readonly hooks: TorrentSessionHooks;
  private currentValue: CurrentTorrent | null = null;
  private readonly starts = new Generation();
  private readonly queue = new SerialQueue();

  constructor(backend: TorrentBackend, hooks: TorrentSessionHooks) {
    this.backend = backend;
    this.hooks = hooks;
  }

  get current(): CurrentTorrent | null {
    return this.currentValue;
  }

  start(magnet: string): Promise<TorrentStartResult> {
    const generation = this.starts.next();
    return this.queue.run(async () => {
      if (!this.starts.isCurrent(generation)) return SUPERSEDED;
      try {
        return await this.replace(magnet, generation);
      } catch (reason) {
        if (!this.starts.isCurrent(generation)) return SUPERSEDED;
        throw reason;
      }
    });
  }

  private async replace(magnet: string, generation: number): Promise<TorrentStartResult> {
    await this.clear();
    if (!this.starts.isCurrent(generation)) return SUPERSEDED;

    const response = await this.backend.addMagnet(magnet);
    if (response.id === undefined) throw new Error('The torrent engine did not return a session ID.');
    if (!this.starts.isCurrent(generation)) {
      await this.forget(response.id);
      return SUPERSEDED;
    }

    const chosen = chooseVideoFile(response.details.files);
    if (!chosen) {
      await this.forget(response.id);
      throw new Error('This torrent does not contain a supported video file.');
    }

    const torrent: CurrentTorrent = {
      id: response.id,
      details: response.details,
      video: chosen.file,
      fileId: chosen.fileId
    };
    this.currentValue = torrent;
    await this.hooks.onStarted(torrent);
    return { status: 'started', torrent };
  }

  private async clear(): Promise<void> {
    const previous = this.currentValue;
    if (!previous) return;
    await this.hooks
      .stopPlayback(previous)
      .catch((reason) => console.warn('The previous episode could not be stopped.', reason));
    await this.forget(previous.id);
    this.currentValue = null;
    this.hooks.onCleared();
  }

  private async forget(id: number): Promise<void> {
    await this.backend
      .forget(id)
      .catch((reason) => console.warn(`Torrent ${id} could not be removed from the session.`, reason));
  }
}
