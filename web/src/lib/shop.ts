import type { InteractiveEmoteAnimation, ShopItem } from './types';

export const DEFAULT_CARD_BACK_URL = '/shop-assets/card-backs/house-default.svg';

/** Resolves a card back item's `asset.svg` to a static URL served from `/shop-assets/card-backs/…`. */
export function resolveCardBackUrl(item: Pick<ShopItem, 'asset'> | null | undefined): string {
  const raw = item?.asset?.svg?.trim();
  if (!raw) return DEFAULT_CARD_BACK_URL;
  if (raw.startsWith('/') || /^https?:\/\//i.test(raw)) return raw;
  return `/${raw}`;
}

export interface EmoteVisualSpec {
  animation: InteractiveEmoteAnimation;
  badge: string;
  actionLabel: string;
  impactWord: string;
}

export const EMOTE_SPECS: Record<InteractiveEmoteAnimation, EmoteVisualSpec> = {
  slap: {
    animation: 'slap',
    badge: 'White-Glove Slap',
    actionLabel: 'Slaps opponent across the felt',
    impactWord: 'SMACK!',
  },
  punch: {
    animation: 'punch',
    badge: 'Heavy Knockout',
    actionLabel: 'Delivers a velvet-gloved uppercut',
    impactWord: 'POW!',
  },
  poop: {
    animation: 'poop',
    badge: 'Special Delivery',
    actionLabel: 'Arcs a smelly parcel onto target',
    impactWord: 'SPLAT!',
  },
  tomato: {
    animation: 'tomato',
    badge: 'Rotten Tomato',
    actionLabel: 'Hurls a ripe tomato at target avatar',
    impactWord: 'SQUISH!',
  },
  toast: {
    animation: 'toast',
    badge: 'Vintage Flute',
    actionLabel: 'Clinks a crystal champagne flute',
    impactWord: 'CHEERS!',
  },
};

