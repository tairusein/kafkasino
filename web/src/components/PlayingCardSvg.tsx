import { DEFAULT_CARD_BACK_URL } from '../lib/shop';
import type { CardRank, CardSuit, PlayingCard } from '../lib/types';

const SUIT_META: Record<CardSuit, { name: string; color: string; accent: string }> = {
  S: { name: 'Spades', color: '#16161a', accent: '#c9a24b' },
  H: { name: 'Hearts', color: '#8b182c', accent: '#c9a24b' },
  D: { name: 'Diamonds', color: '#8b182c', accent: '#c9a24b' },
  C: { name: 'Clubs', color: '#16161a', accent: '#c9a24b' },
};

function SuitGlyph({ suit, cx, cy, size, color }: { suit: CardSuit; cx: number; cy: number; size: number; color: string }) {
  const s = size / 24;
  return (
    <g transform={`translate(${cx}, ${cy}) scale(${s})`}>
      {suit === 'S' && (
        <path
          d="M0 -11 C-6 -4 -10 0 -10 4.5 C-10 7.8 -7.3 9.8 -4.5 9.8 C-2.5 9.8 -1.1 8.8 -0.4 7.5 L-2.6 12 H2.6 L0.4 7.5 C1.1 8.8 2.5 9.8 4.5 9.8 C7.3 9.8 10 7.8 10 4.5 C10 0 6 -4 0 -11 Z"
          fill={color}
        />
      )}
      {suit === 'H' && (
        <path
          d="M0 10.5 C-6 5 -10 1.2 -10 -3.5 C-10 -7.2 -7.2 -9.8 -4 -9.8 C-1.8 -9.8 -0.4 -8.6 0 -6.8 C0.4 -8.6 1.8 -9.8 4 -9.8 C7.2 -9.8 10 -7.2 10 -3.5 C10 1.2 6 5 0 10.5 Z"
          fill={color}
        />
      )}
      {suit === 'D' && <path d="M0 -11.5 L9.5 0 L0 11.5 L-9.5 0 Z" fill={color} />}
      {suit === 'C' && (
        <g fill={color}>
          <circle cx="0" cy="-5.2" r="4.4" />
          <circle cx="-4.8" cy="1.8" r="4.4" />
          <circle cx="4.8" cy="1.8" r="4.4" />
          <path d="M-0.8 3.5 L-2.8 11.5 H2.8 L0.8 3.5 Z" />
        </g>
      )}
    </g>
  );
}

function CourtCenterEmblem({ rank, suit, color }: { rank: CardRank; suit: CardSuit; color: string }) {
  const isFace = rank === 'J' || rank === 'Q' || rank === 'K';
  const isAce = rank === 'A';

  if (isAce) {
    return (
      <g>
        <circle cx="60" cy="84" r="28" fill="none" stroke="#c9a24b" strokeWidth="1" strokeDasharray="3 2" />
        <SuitGlyph suit={suit} cx={60} cy={84} size={42} color={color} />
      </g>
    );
  }

  if (isFace) {
    const crownTitle = rank === 'K' ? 'KING' : rank === 'Q' ? 'QUEEN' : 'JACK';
    return (
      <g>
        <rect
          x="26"
          y="38"
          width="68"
          height="92"
          rx="6"
          fill="#efe6d4"
          stroke="#c9a24b"
          strokeWidth="1.4"
        />
        {/* Crown motif */}
        <path
          d="M42 56 L48 47 L60 54 L72 47 L78 56 Z"
          fill="#c9a24b"
          stroke={color}
          strokeWidth="1"
          strokeLinejoin="round"
        />
        <SuitGlyph suit={suit} cx={60} cy={84} size={34} color={color} />
        <text
          x="60"
          y="118"
          textAnchor="middle"
          fill={color}
          fontFamily="Cormorant Garamond, Georgia, serif"
          fontSize="10"
          fontWeight="700"
          letterSpacing="2"
        >
          {crownTitle}
        </text>
      </g>
    );
  }

  return <SuitGlyph suit={suit} cx={60} cy={84} size={36} color={color} />;
}

export interface PlayingCardSvgProps {
  card?: PlayingCard | null;
  hidden?: boolean;
  cardBackUrl?: string;
  width?: number;
  height?: number;
  className?: string;
}

/**
 * Pure vector (SVG) playing card.
 * When `hidden` is true (or `card` is omitted), renders the equipped custom card back SVG.
 */
export function PlayingCardSvg({
  card,
  hidden = false,
  cardBackUrl = DEFAULT_CARD_BACK_URL,
  width = 84,
  height = 118,
  className = '',
}: PlayingCardSvgProps) {
  if (hidden || !card) {
    return (
      <span
        className={`playing-card playing-card--back ${className}`.trim()}
        style={{ width, height }}
        role="img"
        aria-label="Face-down playing card"
      >
        <img
          src={cardBackUrl}
          alt="Face-down card"
          width={width}
          height={height}
          draggable={false}
          className="playing-card__back-img"
        />
      </span>
    );
  }

  const meta = SUIT_META[card.suit] ?? SUIT_META.S;

  return (
    <svg
      viewBox="0 0 120 168"
      width={width}
      height={height}
      className={`playing-card ${className}`.trim()}
      role="img"
      aria-label={`${card.rank} of ${meta.name}`}
    >
      {/* Ivory card stock with subtle warm border */}
      <rect x="2" y="2" width="116" height="164" rx="10" fill="#f7f1e3" stroke="#c9a24b" strokeWidth="2" />
      <rect
        x="8"
        y="8"
        width="104"
        height="152"
        rx="6"
        fill="none"
        stroke="#d8c390"
        strokeWidth="0.9"
      />

      {/* Top-left corner index */}
      <text
        x="21"
        y="30"
        textAnchor="middle"
        fill={meta.color}
        fontFamily="Cormorant Garamond, Georgia, serif"
        fontSize={card.rank === '10' ? '20' : '22'}
        fontWeight="700"
      >
        {card.rank}
      </text>
      <SuitGlyph suit={card.suit} cx={21} cy={44} size={15} color={meta.color} />

      {/* Center pip / court artwork */}
      <CourtCenterEmblem rank={card.rank} suit={card.suit} color={meta.color} />

      {/* Bottom-right inverted corner index */}
      <g transform="rotate(180 60 84)">
        <text
          x="21"
          y="30"
          textAnchor="middle"
          fill={meta.color}
          fontFamily="Cormorant Garamond, Georgia, serif"
          fontSize={card.rank === '10' ? '20' : '22'}
          fontWeight="700"
        >
          {card.rank}
        </text>
        <SuitGlyph suit={card.suit} cx={21} cy={44} size={15} color={meta.color} />
      </g>
    </svg>
  );
}

const CHIP_PALETTES: Record<number, { body: string; rim: string; text: string; label: string }> = {
  50: { body: '#23262e', rim: '#c9a24b', text: '#f2ebdd', label: '50' },
  100: { body: '#6b1424', rim: '#e8cf8f', text: '#f2ebdd', label: '100' },
  250: { body: '#1c4b3c', rim: '#d9b863', text: '#f2ebdd', label: '250' },
  500: { body: '#3b2045', rim: '#e8cf8f', text: '#f2ebdd', label: '500' },
  1000: { body: '#b38728', rim: '#16161a', text: '#16161a', label: '1K' },
  5000: { body: '#8b182c', rim: '#f5df9e', text: '#f5df9e', label: '5K' },
};

export function CasinoChipSvg({
  value,
  size = 48,
}: {
  value: number;
  size?: number;
}) {
  const pal = CHIP_PALETTES[value] ?? CHIP_PALETTES[100];
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" className="casino-chip-svg">
      <circle cx="32" cy="32" r="29" fill={pal.body} stroke={pal.rim} strokeWidth="2.5" />
      <circle
        cx="32"
        cy="32"
        r="24.5"
        fill="none"
        stroke={pal.rim}
        strokeWidth="3.2"
        strokeDasharray="6 6"
      />
      <circle cx="32" cy="32" r="18.5" fill={pal.body} stroke={pal.rim} strokeWidth="1.4" />
      <text
        x="32"
        y="36.5"
        textAnchor="middle"
        fill={pal.text}
        fontFamily="Cormorant Garamond, Georgia, serif"
        fontSize="14.5"
        fontWeight="700"
      >
        {pal.label}
      </text>
    </svg>
  );
}

