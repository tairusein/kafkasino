/** Maps server error codes (see supabase/README.md) and Supabase Auth errors to UI copy. */

const SERVER_CODES: Record<string, string> = {
  not_authenticated: 'Your session has expired. Please sign in again.',
  invalid_username: 'Usernames must be 3–20 characters: letters, numbers or underscores.',
  username_taken: 'That username is already taken. Please choose another.',
  invalid_avatar: 'Please choose one of the avatars.',
  invalid_recovery_phrase: 'Recovery phrase or username did not match our records.',
  too_many_recovery_attempts:
    'Too many failed recovery attempts. Please wait 15 minutes before trying again.',
  password_too_short: 'Password must be at least 8 characters.',
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
  round_in_progress: 'Wait for the current hand to finish.',
  round_not_finished: 'The current round is still in progress.',
  bet_out_of_range: 'Bet is below the table minimum or above the maximum.',
  already_bet: 'You have already placed your bet for this round.',
  cannot_double: 'Double Down is only available on your initial two cards.',
  invalid_bet_type: 'Unsupported Roulette bet type.',
  no_bets_placed: 'Place at least one chip on the layout before spinning.',
  tournament_not_found: 'Tournament not found.',
  tournament_not_open: 'Registration for this tournament is closed.',
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

  if (/invalid login credentials/i.test(msg)) return 'Incorrect username or password.';
  if (/user already registered|already been registered|profiles_username_lower_key|username_taken/i.test(msg)) {
    return 'That username is already taken. Please choose another.';
  }
  if (/email not confirmed/i.test(msg)) {
    return 'Incorrect username or password.';
  }
  if (/invalid.*email|email.*invalid|unable to validate/i.test(msg)) {
    return 'Enter a valid username (3–20 letters, numbers or underscores).';
  }
  if (/database error saving new user/i.test(msg)) {
    return 'Could not complete registration. Please try a different username or run Migration 14 in Supabase SQL Editor.';
  }
  if (/tournaments_featured_not_draft/i.test(msg)) {
    return 'The featured homepage banner tournament cannot be in Draft status.';
  }
  if (/password should be at least/i.test(msg)) return 'Password must be at least 8 characters.';
  if (/rate limit|too many requests|over_email_send_rate_limit/i.test(msg)) {
    return 'Too many attempts. Please try again shortly.';
  }
  if (/failed to fetch|networkerror/i.test(msg)) {
    return 'Cannot reach the server. Check your connection.';
  }

  // Scrub any internal synthetic domain or email terminology so the user never sees it.
  const sanitized = msg
    .replace(/[a-z0-9._-]+@kafkasino\.[a-z]+/gi, 'username')
    .replace(/\bemail address\b/gi, 'username')
    .replace(/\bemail\b/gi, 'username');

  return sanitized || 'Something went wrong. Please try again.';
}
