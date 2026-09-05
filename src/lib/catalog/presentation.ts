import type { AnimeSeason, AniListMatchableMedia } from '$lib/types';

export const SEASON_ORDER: AnimeSeason[] = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];

export function currentSeason(date = new Date()): { season: AnimeSeason; year: number } {
  return { season: SEASON_ORDER[Math.floor(date.getMonth() / 3)], year: date.getFullYear() };
}

export function shiftSeason(season: AnimeSeason, year: number, amount: number) {
  const absolute = year * 4 + SEASON_ORDER.indexOf(season) + amount;
  return { season: SEASON_ORDER[((absolute % 4) + 4) % 4], year: Math.floor(absolute / 4) };
}

export function preferredTitle(show: AniListMatchableMedia): string {
  return show.title.english || show.title.userPreferred || show.title.romaji ||
    show.title.native || `AniList #${show.id}`;
}

export function providerImageUrl(path: string): string {
  if (!path) return '';
  try {
    const url = new URL(path, 'https://subsplease.org');
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (!code.startsWith('#')) return named[code.toLowerCase()] ?? entity;
    const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  });
}

export function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function metadataLabel(value: string): string {
  if (['TV', 'ONA', 'OVA'].includes(value)) return value;
  return value.toLowerCase().replaceAll('_', ' ').replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}
