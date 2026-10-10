import type { AnimeSeason, AniListMatchableMedia } from '$lib/types';

export { errorMessage } from '$lib/errors';

export const SEASON_ORDER: AnimeSeason[] = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];

export function currentSeason(date = new Date()): { season: AnimeSeason; year: number } {
  return { season: SEASON_ORDER[Math.floor(date.getMonth() / 3)], year: date.getFullYear() };
}

export function seasonOrdinal(season: AnimeSeason, year: number): number {
  return year * SEASON_ORDER.length + SEASON_ORDER.indexOf(season);
}

export function seasonLabel(season: AnimeSeason): string {
  return `${season[0]}${season.slice(1).toLowerCase()}`;
}

export function shiftSeason(season: AnimeSeason, year: number, amount: number) {
  const absolute = seasonOrdinal(season, year) + amount;
  return { season: SEASON_ORDER[((absolute % 4) + 4) % 4], year: Math.floor(absolute / 4) };
}

export function preferredTitle(show: AniListMatchableMedia): string {
  return show.title.english || show.title.userPreferred || show.title.romaji ||
    show.title.native || `AniList #${show.id}`;
}

export function posterUrl(path: string): string {
  if (!path) return '';
  try {
    const url = new URL(path, 'https://subsplease.org');
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', laquo: '\u00ab', raquo: '\u00bb', middot: '\u00b7',
  times: '\u00d7', deg: '\u00b0', star: '\u2606', hearts: '\u2665'
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (!code.startsWith('#')) return NAMED_ENTITIES[code] ?? NAMED_ENTITIES[code.toLowerCase()] ?? entity;
    const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  });
}

export function metadataLabel(value: string): string {
  if (['TV', 'ONA', 'OVA'].includes(value)) return value;
  return value.toLowerCase().replaceAll('_', ' ').replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}
