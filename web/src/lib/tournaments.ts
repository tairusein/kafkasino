import { supabase } from './supabase';

export interface PrizeArtPreset {
  label: string;
  path: string;
}

export const PRIZE_ART_PRESETS: readonly PrizeArtPreset[] = [
  { label: 'Royal Chronograph (SVG)', path: '/tournaments/royal-chronograph.svg' },
  { label: 'Sovereign Chalice (SVG)', path: '/tournaments/sovereign-chalice.svg' },
  { label: 'Imperial Bullion Case (SVG)', path: '/tournaments/imperial-case.svg' },
] as const;

export const DEFAULT_PRIZE_IMAGE = PRIZE_ART_PRESETS[0].path;

/**
 * Resolves a tournament's `prize_image_path`:
 *  - Built-in vector paths (`/tournaments/...`) or full URLs (`https://...`) are used directly.
 *  - Otherwise the path is resolved from the public `tournament-images` Supabase Storage bucket.
 */
export function resolveTournamentImageUrl(prizeImagePath: string | null | undefined): string {
  const trimmed = prizeImagePath?.trim();
  if (!trimmed) return DEFAULT_PRIZE_IMAGE;
  if (trimmed.startsWith('/') || /^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  const { data } = supabase.storage.from('tournament-images').getPublicUrl(trimmed);
  return data.publicUrl || DEFAULT_PRIZE_IMAGE;
}

/**
 * Uploads a prize image file (PNG/JPEG/WebP, max 5 MB) to the `tournament-images` storage bucket.
 * Enforced server-side by the `kafkasino_tournament_images_insert` RLS policy (`is_admin()`).
 */
export async function uploadTournamentPrizeImage(file: File): Promise<string> {
  const allowed = ['image/png', 'image/jpeg', 'image/webp'];
  if (!allowed.includes(file.type)) {
    throw new Error('Prize image must be PNG, JPEG, or WebP (or use one of the built-in vector SVGs).');
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new Error('Prize image must be smaller than 5 MB.');
  }
  const ext = file.name.split('.').pop()?.toLowerCase() || 'png';
  const safeExt = ['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? ext : 'png';
  const objectPath = `prizes/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${safeExt}`;

  const { error } = await supabase.storage.from('tournament-images').upload(objectPath, file, {
    cacheControl: '3600',
    upsert: false,
    contentType: file.type,
  });
  if (error) throw error;
  return objectPath;
}

