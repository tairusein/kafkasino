/** Row shapes returned by the database (see supabase/migrations). */

export interface Profile {
  id: string;
  username: string;
  avatar_id: string;
  equipped_card_back: string | null;
  created_at: string;
}

export interface GameCatalogEntry {
  slug: string;
  name: string;
  min_players: number;
  max_players: number;
  is_enabled: boolean;
}

export interface LobbyRoom {
  id: string;
  game_type: string;
  name: string;
  status: 'waiting' | 'playing' | 'closed';
  max_players: number;
  min_bet: number;
  created_at: string;
  room_players: { count: number }[];
}

export type RoomVisibility = 'public' | 'private';
export type RoomStatus = 'waiting' | 'playing' | 'closed';
export type SeatStatus = 'active' | 'afk' | 'spectating';

export interface Room {
  id: string;
  game_type: string;
  name: string;
  visibility: RoomVisibility;
  host_id: string;
  status: RoomStatus;
  max_players: number;
  min_bet: number;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface RoomPlayer {
  room_id: string;
  user_id: string;
  seat: number;
  status: SeatStatus;
  stack: number;
  joined_at: string;
  last_seen_at: string;
  afk_since: string | null;
}

export interface RoomSeatWithProfile extends RoomPlayer {
  username: string;
  avatar_id: string;
  equipped_card_back: string | null;
}

export interface GameLastAction {
  type: string;
  user_id: string;
  payload?: Record<string, unknown>;
  forced_by_timeout?: boolean;
  at: string;
}

export type CardSuit = 'S' | 'H' | 'D' | 'C';
export type CardRank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K';

export interface PlayingCard {
  rank: CardRank;
  suit: CardSuit;
}

export type BlackjackHandStatus =
  | 'betting'
  | 'bet_placed'
  | 'skipped_afk'
  | 'playing'
  | 'stood'
  | 'doubled'
  | 'blackjack'
  | 'bust';

export type BlackjackOutcome = 'blackjack' | 'win' | 'push' | 'lose' | 'bust' | null;

export interface BlackjackHandState {
  user_id: string;
  seat: number;
  bet: number;
  cards: PlayingCard[];
  total: number;
  is_soft: boolean;
  is_blackjack: boolean;
  status: BlackjackHandStatus;
  outcome: BlackjackOutcome;
  payout: number;
  net: number;
}

export interface BlackjackDealerState {
  cards: PlayingCard[];
  hole_hidden: boolean;
  total: number;
  is_soft: boolean;
  is_blackjack: boolean;
  is_bust: boolean;
}

export type RouletteBetKind =
  | 'straight'
  | 'red'
  | 'black'
  | 'even'
  | 'odd'
  | 'low'
  | 'high'
  | 'dozen_1'
  | 'dozen_2'
  | 'dozen_3'
  | 'col_1'
  | 'col_2'
  | 'col_3';

export type RouletteColor = 'green' | 'red' | 'black';

export interface RouletteBetItem {
  kind: RouletteBetKind;
  number: number | null;
  amount: number;
  multiplier?: number;
  payout?: number;
  won?: boolean;
}

export interface RouletteTicketState {
  user_id: string;
  seat: number;
  status: 'betting' | 'bet_placed' | 'skipped_afk';
  total_bet: number;
  bets: RouletteBetItem[];
  payout: number;
  net: number;
}

export interface RouletteHistoryEntry {
  number: number;
  color: RouletteColor;
  round: number;
}

export type SlotSymbol = 'crown' | 'seven' | 'diamond' | 'bell' | 'bar' | 'cherry';

export interface SlotHistoryEntry {
  round: number;
  reels: SlotSymbol[];
  bet: number;
  multiplier: number;
  payout: number;
  net: number;
  tier: string;
}

export type PokerStreet = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

export interface PokerPlayerState {
  user_id: string;
  seat: number;
  status: 'active' | 'folded';
  street_bet: number;
  total_bet: number;
  acted: boolean;
  is_dealer: boolean;
  is_sb: boolean;
  is_bb: boolean;
  revealed_cards: PlayingCard[] | null;
  hand_label: string | null;
  payout: number;
  net: number;
  is_winner: boolean;
}

export interface DurakTablePair {
  attack: PlayingCard;
  defense: PlayingCard | null;
}

export interface DurakPlayerState {
  user_id: string;
  seat: number;
  card_count: number;
  stake: number;
  payout: number;
  is_winner: boolean;
}

export interface BoardLastMove {
  from: [number, number];
  to: [number, number];
  piece: string;
  captured?: string | null;
  jumped?: boolean;
}

export interface GameStateRow {
  room_id: string;
  version: number;
  phase: string;
  state: {
    round_number?: number;
    turn_number?: number;
    min_bet?: number;
    shoe_remaining?: number;
    dealer?: BlackjackDealerState;
    hands?: Record<string, BlackjackHandState>;
    winning_number?: number | null;
    winning_color?: RouletteColor | null;
    tickets?: Record<string, RouletteTicketState>;
    history?: (RouletteHistoryEntry | SlotHistoryEntry)[];
    rtp_percent?: number;
    reels?: SlotSymbol[];
    stops?: number[];
    bet?: number;
    multiplier?: number;
    payout?: number;
    net?: number;
    tier?: string;
    street?: PokerStreet;
    pot?: number;
    current_bet?: number;
    min_raise?: number;
    small_blind?: number;
    big_blind?: number;
    dealer_seat?: number;
    community_cards?: PlayingCard[];
    players?: Record<string, PokerPlayerState & DurakPlayerState & Record<string, unknown>>;
    deck_remaining?: number;
    trump_card?: PlayingCard | null;
    trump_suit?: CardSuit;
    attacker_id?: string;
    defender_id?: string;
    bout_subphase?: 'attacking' | 'defending';
    table_pairs?: DurakTablePair[];
    winner_id?: string | null;
    board?: (string | null)[][];
    white_id?: string;
    black_id?: string;
    red_id?: string;
    turn_color?: string;
    captured_w?: string[];
    captured_b?: string[];
    red_left?: number;
    black_left?: number;
    win_reason?: string | null;
    last_move?: BoardLastMove | null;
    last_action?: GameLastAction;
    [key: string]: unknown;
  };
  turn_user_id: string | null;
  turn_deadline: string | null;
  updated_at: string;
}

export interface ChatMessageRow {
  id: number;
  room_id: string;
  user_id: string;
  body: string;
  created_at: string;
}

export type TournamentStatus = 'draft' | 'upcoming' | 'live' | 'finished' | 'cancelled';

export interface Tournament {
  id: string;
  title: string;
  description: string;
  game_type: string | null;
  prize_name: string;
  prize_image_path: string | null;
  starts_at: string;
  entry_fee: number;
  max_participants: number | null;
  status: TournamentStatus;
  is_featured: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TournamentParticipant {
  tournament_id: string;
  user_id: string;
  fee_paid: number;
  registered_at: string;
}

export interface AppConfigRow {
  key: string;
  value: unknown;
  description: string | null;
  updated_at: string;
}

export interface BonusStatus {
  can_claim: boolean;
  amount: number;
  next_reset_at: string;
  server_now: string;
  last_claim_at: string | null;
}

export interface BonusClaimResult {
  amount: number;
  balance: number;
  next_reset_at: string;
  server_now: string;
}

export type ShopItemKind = 'card_back' | 'emote';
export type InteractiveEmoteAnimation = 'slap' | 'punch' | 'poop' | 'tomato' | 'toast';

export interface ShopItem {
  id: string;
  slug: string;
  kind: ShopItemKind;
  name: string;
  description: string;
  price: number;
  asset: {
    svg?: string;
    animation?: InteractiveEmoteAnimation;
  };
  is_interactive: boolean;
  is_consumable: boolean;
  grant_quantity: number;
  is_active: boolean;
  sort_order: number;
}

export interface UserItem {
  user_id: string;
  item_id: string;
  quantity: number;
  acquired_at: string;
}

export interface QuickEmoteEvent {
  id: string;
  sender_id: string;
  emote_id: string;
  symbol: string;
  phrase: string;
  sent_at: number;
}

export interface InteractiveEmoteEvent {
  id: string;
  sender_id: string;
  target_id: string;
  animation: InteractiveEmoteAnimation;
  name: string;
  sent_at: number;
}
