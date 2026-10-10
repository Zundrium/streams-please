export type PlayerShortcut =
  | 'close-queue'
  | 'exit-fullscreen'
  | 'close-trailer'
  | 'exit-theater'
  | 'toggle-playback'
  | 'seek-backward'
  | 'seek-forward'
  | 'toggle-mute'
  | 'toggle-fullscreen';

export type ShortcutKey = {
  key: string;
  code: string;
  fromEditable: boolean;
};

export type ShortcutContext = {
  queueOpen: boolean;
  fullscreen: boolean;
  trailerOpen: boolean;
  theater: boolean;
  episodeLoaded: boolean;
};

const MEDIA_KEYS: Record<string, PlayerShortcut> = {
  Space: 'toggle-playback',
  ArrowLeft: 'seek-backward',
  ArrowRight: 'seek-forward'
};

const LETTER_KEYS: Record<string, PlayerShortcut> = {
  m: 'toggle-mute',
  f: 'toggle-fullscreen'
};

export function resolvePlayerShortcut(
  input: ShortcutKey,
  context: ShortcutContext
): PlayerShortcut | null {
  if (input.key === 'Escape') {
    if (context.queueOpen) return 'close-queue';
    if (context.fullscreen) return 'exit-fullscreen';
    if (context.trailerOpen) return 'close-trailer';
    if (context.theater) return 'exit-theater';
  }
  if (input.fromEditable || (!context.trailerOpen && !context.episodeLoaded)) return null;
  return MEDIA_KEYS[input.code] ?? LETTER_KEYS[input.key.toLowerCase()] ?? null;
}
