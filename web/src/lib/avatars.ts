/**
 * The 10 registration avatars. IDs MUST match public.avatars (supabase migration 2);
 * the database validates the chosen id, this list only drives the UI so the
 * registration screen needs no network round-trip.
 * Images live in web/public/avatars/<id>.jpg (1024x1024)
 */
export interface AvatarDef {
  id: string;
  name: string;
  title: string;
}

export const AVATARS: readonly AvatarDef[] = [
  { id: 'fox', name: 'Fox', title: 'The Barrister' },
  { id: 'owl', name: 'Owl', title: 'The Professor' },
  { id: 'bear', name: 'Bear', title: 'The Executive' },
  { id: 'wolf', name: 'Wolf', title: 'The Detective' },
  { id: 'lion', name: 'Lion', title: 'The Chairman' },
  { id: 'raccoon', name: 'Raccoon', title: 'The Accountant' },
  { id: 'elephant', name: 'Elephant', title: 'The Diplomat' },
  { id: 'penguin', name: 'Penguin', title: "The Maître d'" },
  { id: 'eagle', name: 'Eagle', title: 'The Captain' },
  { id: 'panther', name: 'Panther', title: 'The Gentleman' },
] as const;

export function avatarUrl(id: string): string {
  return `/avatars/${id}.jpg`;
}

export function avatarLabel(id: string): string {
  const a = AVATARS.find((x) => x.id === id);
  return a ? `${a.title} — ${a.name}` : 'Avatar';
}

