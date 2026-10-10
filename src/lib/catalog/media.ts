import { DAY_ORDER } from '$lib/types';
import type {
  DayName,
  PlaybackQuality,
  SubsPleaseDownload,
  SubsPleaseRelease,
  SubsPleaseScheduleResponse,
  SubsPleaseScheduleShow
} from '$lib/types';

export interface TrailerSource {
  id?: string;
  site: string;
}

export interface TrailerLinks {
  watchUrl: string;
  embedUrl: string;
}

export function trailerLinks(trailer: TrailerSource | null | undefined, origin = ''): TrailerLinks {
  if (!trailer?.id) return { watchUrl: '', embedUrl: '' };
  const id = encodeURIComponent(trailer.id);
  const site = trailer.site.toLowerCase();
  if (site === 'youtube') {
    const parameters = new URLSearchParams({ rel: '0', playsinline: '1' });
    if (/^https?:\/\//.test(origin)) {
      parameters.set('origin', origin);
      parameters.set('widget_referrer', origin);
    }
    return {
      watchUrl: `https://www.youtube.com/watch?v=${id}`,
      embedUrl: `https://www.youtube.com/embed/${id}?${parameters}`
    };
  }
  if (site === 'dailymotion') {
    return {
      watchUrl: `https://www.dailymotion.com/video/${id}`,
      embedUrl: `https://www.dailymotion.com/embed/video/${id}`
    };
  }
  return { watchUrl: '', embedUrl: '' };
}

export function preferredDownload(
  release: SubsPleaseRelease,
  preferredQuality: PlaybackQuality
): SubsPleaseDownload | undefined {
  return (
    release.downloads.find((download) => download.res === preferredQuality) ??
    [...release.downloads].sort((left, right) => Number(right.res) - Number(left.res))[0]
  );
}

export function scheduledProvider(
  slug: string,
  schedule: SubsPleaseScheduleResponse | null | undefined
): { show: SubsPleaseScheduleShow; day: DayName } | undefined {
  for (const day of DAY_ORDER) {
    const show = schedule?.schedule[day]?.find((candidate) => candidate.page === slug);
    if (show) return { show, day };
  }
  return undefined;
}
