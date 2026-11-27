import type { CurrentTorrent, MpvTrack, TorrentFile, TorrentStats } from '$lib/types';

export type PlaybackBufferRange = {
  start: number;
  end: number;
};

export const VIDEO_EXTENSIONS = ['.mkv', '.mk3d', '.mp4', '.m4v', '.mov', '.webm', '.avi', '.ts', '.m2ts'];

export function chooseVideoFile(
  files: readonly TorrentFile[] | undefined
): { file: TorrentFile; fileId: number } | undefined {
  return (files ?? [])
    .map((file, fileId) => ({ file, fileId }))
    .filter(({ file }) =>
      VIDEO_EXTENSIONS.some((extension) => file.name.toLowerCase().endsWith(extension))
    )
    .sort((left, right) => right.file.length - left.file.length)[0];
}

export function formatBytes(bytes = 0): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(index > 2 ? 2 : index > 0 ? 1 : 0)} ${units[index]}`;
}

export function readableTitle(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeTracks(value: unknown): MpvTrack[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const source = item as Record<string, unknown>;
    if (source.type !== 'video' && source.type !== 'audio' && source.type !== 'sub') return [];
    const id = Number(source.id);
    if (!Number.isSafeInteger(id) || id <= 0) return [];
    return [
      {
        id,
        type: source.type,
        lang: typeof source.lang === 'string' ? source.lang : undefined,
        title: typeof source.title === 'string' ? source.title : undefined,
        codec: typeof source.codec === 'string' ? source.codec : undefined,
        selected: Boolean(source.selected),
        external: Boolean(source.external)
      }
    ];
  });
}

export function inferPieceLength(totalBytes: number, pieceSlots: number): number {
  if (totalBytes <= 0 || pieceSlots <= 0) return 0;
  for (let exponent = 14; exponent <= 26; exponent += 1) {
    const candidate = 2 ** exponent;
    const actualPieces = Math.ceil(totalBytes / candidate);
    if (actualPieces <= pieceSlots && pieceSlots - actualPieces < 8) return candidate;
  }
  return totalBytes / pieceSlots;
}

type VideoPieceSpan = {
  pieces: boolean[];
  pieceLength: number;
  fileStart: number;
  fileEnd: number;
  fileLength: number;
  firstPiece: number;
  lastPiece: number;
};

function videoPieceSpan(
  torrentStats: TorrentStats | null,
  torrent: CurrentTorrent | null
): VideoPieceSpan | null {
  const pieces = torrentStats?.pieces;
  const files = torrent?.details.files;
  if (!pieces?.length || !torrent || !files?.length) return null;

  const totalBytes =
    torrentStats?.total_bytes || files.reduce((sum, file) => sum + file.length, 0);
  const pieceLength = inferPieceLength(totalBytes, pieces.length);
  const fileLength = torrent.video.length;
  if (pieceLength <= 0 || fileLength <= 0) return null;

  const fileStart = files
    .slice(0, torrent.fileId)
    .reduce((sum, file) => sum + file.length, 0);
  const fileEnd = fileStart + fileLength;
  return {
    pieces,
    pieceLength,
    fileStart,
    fileEnd,
    fileLength,
    firstPiece: Math.max(0, Math.floor(fileStart / pieceLength)),
    lastPiece: Math.min(pieces.length - 1, Math.ceil(fileEnd / pieceLength) - 1)
  };
}

export function bufferedSecondsAhead(
  torrentStats: TorrentStats | null,
  torrent: CurrentTorrent | null,
  duration: number,
  position: number
): number | null {
  const span = videoPieceSpan(torrentStats, torrent);
  if (!span || duration <= 0) return null;
  const { pieces, pieceLength, fileStart, fileEnd, fileLength, lastPiece } = span;
  const fraction = Math.max(0, Math.min(1, position / duration));
  const positionByte = fileStart + fraction * fileLength;
  let index = Math.min(lastPiece, Math.floor(positionByte / pieceLength));
  while (index <= lastPiece && pieces[index]) index += 1;
  const bufferedByte = Math.min(fileEnd, index * pieceLength);
  return (Math.max(0, bufferedByte - positionByte) / fileLength) * duration;
}

export function torrentPieceRanges(
  torrentStats: TorrentStats | null,
  torrent: CurrentTorrent | null,
  duration: number
): PlaybackBufferRange[] {
  const span = videoPieceSpan(torrentStats, torrent);
  if (!span || duration <= 0) return [];
  const { pieces, pieceLength, fileStart, fileEnd, fileLength, firstPiece, lastPiece } = span;
  const visualMergeGap = Math.min(
    0.5,
    Math.max(0.12, (pieceLength / fileLength) * 100 * 2)
  );
  const ranges: PlaybackBufferRange[] = [];

  for (let index = firstPiece; index <= lastPiece; index += 1) {
    if (!pieces[index]) continue;
    const startByte = Math.max(fileStart, index * pieceLength);
    const endByte = Math.min(fileEnd, (index + 1) * pieceLength);
    const range = {
      start: ((startByte - fileStart) / fileLength) * 100,
      end: ((endByte - fileStart) / fileLength) * 100
    };
    const previous = ranges[ranges.length - 1];
    if (previous && range.start <= previous.end + visualMergeGap) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      ranges.push(range);
    }
  }

  return ranges;
}
