export interface QuickEmotePreset {
  id: string;
  symbol: string;
  phrase: string;
}

export const QUICK_EMOTES: readonly QuickEmotePreset[] = [
  { id: 'good-luck', symbol: '🎩', phrase: 'Good luck' },
  { id: 'well-played', symbol: '🥂', phrase: 'Well played' },
  { id: 'bold', symbol: '♠️', phrase: 'Fortune favors the bold' },
  { id: 'thinking', symbol: '🧐', phrase: 'Calculating odds…' },
  { id: 'cold-deck', symbol: '💔', phrase: 'Cold deck!' },
  { id: 'your-move', symbol: '⏱️', phrase: 'Your move' },
  { id: 'thanks', symbol: '✨', phrase: 'Much obliged' },
  { id: 'splendid', symbol: '👑', phrase: 'Splendid hand' },
] as const;

