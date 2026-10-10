const YOUTUBE_TRAILER_SEARCH_SUFFIX = 'trailer English subtitles';
const YOUTUBE_TRAILER_SEARCH_PREFIX = 'ytdl://ytsearch1:';

export function youtubeTrailerSearchQuery(title: string): string {
  const normalizedTitle = title.replace(/\s+/g, ' ').trim().slice(0, 160);
  return normalizedTitle ? `${normalizedTitle} ${YOUTUBE_TRAILER_SEARCH_SUFFIX}` : '';
}

export function youtubeTrailerSearchPlaybackUrl(title: string): string {
  const query = youtubeTrailerSearchQuery(title);
  return query ? `${YOUTUBE_TRAILER_SEARCH_PREFIX}${query}` : '';
}

export function isYoutubeTrailerSearchPlaybackUrl(value: string): boolean {
  if (!value.startsWith(YOUTUBE_TRAILER_SEARCH_PREFIX)) return false;
  const query = value.slice(YOUTUBE_TRAILER_SEARCH_PREFIX.length);
  return (
    query.length > YOUTUBE_TRAILER_SEARCH_SUFFIX.length &&
    query.length <= 190 &&
    query === query.trim() &&
    !/[\u0000-\u001f\u007f]/.test(query)
  );
}

export function youtubeTrailerSearchPageUrl(title: string): string {
  const query = youtubeTrailerSearchQuery(title);
  return query
    ? `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
    : '';
}

const TRAILER_DOMAINS = ['youtube.com', 'dailymotion.com'];
const TRAILER_HOSTS = ['youtu.be'];

function isTrailerHost(host: string): boolean {
  return (
    TRAILER_HOSTS.includes(host) ||
    TRAILER_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
  );
}

export function isSupportedTrailerUrl(value: string): boolean {
  if (isYoutubeTrailerSearchPlaybackUrl(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && isTrailerHost(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}
