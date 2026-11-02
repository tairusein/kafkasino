/** Maps server error codes (see supabase/README.md) and Supabase Auth errors to UI copy. */

const SERVER_CODES: Record<string, string> = {
  not_authenticated: 'Your session has expired. Please sign in again.',
  invalid_username: 'Usernames must be 3–20 characters: letters, numbers or underscores.',
  invalid_avatar: 'Please choose one of the avatars.',
  insufficient_funds: 'You do not have enough chips for that.',
  bonus_already_claimed: 'Today’s bonus has already been claimed.',
  already_owned: 'You already own this item.',
  item_not_found: 'This shop item is no longer available.',
  item_not_owned: 'You do not own that card back yet.',
  invalid_quantity: 'Please choose a valid quantity (1–100).',
  no_charges_left: 'You have no charges left for that emote. Visit the Shop to restock.',
  game_not_available: 'That game is not enabled yet.',
  invalid_visibility: 'Room visibility must be Public or Private.',
  invalid_name: 'Room name must be between 1 and 40 characters.',
  invalid_min_bet: 'Minimum bet cannot be negative.',
  invalid_max_players: 'Player count is outside the allowed range for this game.',
  room_not_found: 'That room no longer exists or is private.',
  room_full: 'That room is full.',
  already_in_another_room: 'You are already seated at another table. Leave or rejoin that table first.',
  invalid_pin: 'Invalid PIN code. Check the 6-character code and try again.',
  too_many_attempts: 'Too many wrong PINs. Please wait 10 minutes before trying again.',
  not_in_room: 'You are not seated at this table.',
  target_not_in_room: 'That player is no longer at this table.',
  cannot_target_self: 'Choose an opponent’s seat to target.',
  rate_limited: 'You are sending messages too quickly. Wait a moment.',
  invalid_message: 'Chat message must be 1–300 characters.',
  not_your_turn: 'It is not your turn to act.',
  no_active_players: 'At least one active player is required.',
  invalid_action: 'Invalid game action.',
  round_already_active: 'A hand is already in progress at this table.',
  invalid_bet_amount: 'Bet amount must meet the table minimum.',
  bet_already_placed: 'Your bet for this hand has already been placed.',
  double_only_on_two_cards: 'Double Down is only available on your initial two cards.',
  forbidden: 'You are not allowed to do that.',
  tournament_not_found: 'That tournament could not be found.',
  tournament_not_found_or_draft: 'Draft tournaments cannot be featured. Set status to Upcoming or Live first.',
  registration_closed: 'Registration for this tournament is closed.',
  already_registered: 'You are already registered for this tournament.',
  tournament_full: 'This tournament has reached its maximum capacity.',
  not_registered: 'You are not registered for this tournament.',
  reason_required: 'Please provide a reason (at least 3 characters) for the ledger.',
  unknown_config_key: 'Unknown configuration key.',
  invalid_value: 'That configuration value is out of range or invalid.',
  amount_must_be_nonzero: 'Amount must not be zero.',
  wallet_not_found: 'Player wallet not found.',
};

function messageOf(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return '';
}

export function friendlyError(err: unknown): string {
  const msg = messageOf(err).trim();
  if (SERVER_CODES[msg]) return SERVER_CODES[msg];

  if (/invalid login credentials/i.test(msg)) return 'Incorrect email or password.';
  if (/email not confirmed/i.test(msg)) return 'Please confirm your email address first.';
  if (/user already registered/i.test(msg)) return 'An account with this email already exists.';
  // The signup trigger raises on a taken/invalid username; GoTrue wraps it generically.
  if (/database error saving new user/i.test(msg) || /profiles_username_lower_key/i.test(msg)) {
    return 'That username is already taken. Please choose another.';
  }
  if (/tournaments_featured_not_draft/i.test(msg)) {
    return 'The featured homepage banner tournament cannot be in Draft status.';
  }
  if (/password should be at least/i.test(msg)) return 'Password must be at least 8 characters.';
  if (/rate limit|too many requests/i.test(msg)) return 'Too many attempts. Please try again shortly.';
  if (/failed to fetch|networkerror/i.test(msg)) return 'Cannot reach the server. Check your connection.';
  return msg || 'Something went wrong. Please try again.';
}
