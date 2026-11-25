import type { YouTubeVideoItem } from '../types';

export const CURATED_YOUTUBE_360: readonly YouTubeVideoItem[] = [
  {
    id: 'hEdzv7D4CbQ',
    title: 'ISS Spacewalk 360°',
    subtitle: 'Orbital Earth & Aurora VR Dome',
    preset: 'orbital360',
    is360: true,
  },
  {
    id: '2OEL4P1Rz04',
    title: 'Swiss Alps Aerial 360°',
    subtitle: 'High-Altitude Alpine Panorama',
    preset: 'alpine360',
    is360: true,
  },
  {
    id: 'v64KOxKVLVg',
    title: 'Coral Reef Dive 360°',
    subtitle: 'Bioluminescent Ocean Dome',
    preset: 'reef360',
    is360: true,
  },
  {
    id: '7AkbUfZjS5k',
    title: 'Tokyo Night Walk 360°',
    subtitle: 'Neon Metropolis Surround View',
    preset: 'tokyo360',
    is360: true,
  },
];

const VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;

/**
 * Extracts a valid 11-character YouTube Video ID from a full URL, short link,
 * embed URL, shorts URL, or raw video ID. Returns null if invalid.
 */
export function parseYouTubeVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (VIDEO_ID_REGEX.test(trimmed)) {
    return trimmed;
  }

  let normalized = trimmed;
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`;
  }

  try {
    const url = new URL(normalized);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');

    if (host === 'youtu.be') {
      const candidate = url.pathname.split('/').filter(Boolean)[0] ?? '';
      return VIDEO_ID_REGEX.test(candidate) ? candidate : null;
    }

    if (
      host === 'youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'youtube-nocookie.com'
    ) {
      const watchId = url.searchParams.get('v');
      if (watchId && VIDEO_ID_REGEX.test(watchId)) {
        return watchId;
      }

      const parts = url.pathname.split('/').filter(Boolean);
      if (
        parts.length >= 2 &&
        (parts[0] === 'embed' || parts[0] === 'shorts' || parts[0] === 'live')
      ) {
        return VIDEO_ID_REGEX.test(parts[1]) ? parts[1] : null;
      }
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Builds a privacy-enhanced, playsinline YouTube embed URL suitable for
 * floating spatial cinema & Phone VR viewing.
 */
export function buildYouTubeEmbedUrl(
  videoId: string,
  autoplay = true,
): string {
  if (!VIDEO_ID_REGEX.test(videoId)) {
    throw new Error(`Invalid YouTube video ID: ${videoId}`);
  }
  const params = new URLSearchParams({
    autoplay: autoplay ? '1' : '0',
    playsinline: '1',
    rel: '0',
    modestbranding: '1',
    enablejsapi: '1',
  });
  return `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
}
