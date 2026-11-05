/**
 * Cryptographic 12-Word Recovery Phrase (Seed Phrase) Generator & SHA-256 Hasher.
 *
 * Security Architecture:
 * 1. Generation uses `window.crypto.getRandomValues` over a 256-word unambiguous
 *    BIP-39 style dictionary (12 words = 96 bits of CSPRNG entropy).
 * 2. Before leaving the browser, the normalized 12-word phrase is hashed via
 *    SHA-256 (`window.crypto.subtle.digest`) with a domain separator so the raw
 *    recovery phrase is NEVER transmitted in plain text or stored in `user_metadata`.
 * 3. On the server (PostgreSQL `pgcrypto`), the digest is salted and hashed with
 *    `bcrypt` (`crypt(digest, gen_salt('bf', 10))`) inside `public.user_recovery_secrets`.
 */

const WORDLIST_256: readonly string[] = [
  'abbey', 'acorn', 'admiral', 'amber', 'anchor', 'anvil', 'apricot', 'arcade',
  'archer', 'argyle', 'armada', 'arrow', 'ascot', 'atlas', 'autumn', 'avalon',
  'badger', 'ballad', 'ballet', 'bamboo', 'banquet', 'baron', 'basalt', 'bastion',
  'beacon', 'belfry', 'velvet', 'bighorn', 'bishop', 'bison', 'blade', 'blossom',
  'bonfire', 'boulder', 'bourbon', 'bramble', 'bravo', 'brigade', 'bronze', 'buckle',
  'cabaret', 'cadence', 'caliber', 'camellia', 'cameo', 'canopy', 'canyon', 'captain',
  'caravan', 'caravel', 'cardinal', 'cascade', 'cashmere', 'citadel', 'cobalt', 'comet',
  'compass', 'concord', 'condor', 'copper', 'avenir', 'coronet', 'corsair', 'cosmos',
  'cougar', 'crest', 'crimson', 'crystal', 'cypress', 'dagger', 'dahlia', 'damask',
  'deacon', 'delta', 'diadem', 'diamond', 'diplomat', 'dolphin', 'domino', 'dragon',
  'dynasty', 'eagle', 'ebony', 'eclipse', 'edelweiss', 'emerald', 'emperor', 'empire',
  'enclave', 'enigma', 'epilogue', 'equinox', 'ermine', 'estuary', 'falcon', 'fathom',
  'fedora', 'ferry', 'festival', 'filigree', 'fjord', 'flannel', 'flint', 'fortress',
  'fountain', 'foxhound', 'frigate', 'frontier', 'galleon', 'gambit', 'garnet', 'gazelle',
  'gentry', 'glacier', 'gladiator', 'gondola', 'granite', 'griffin', 'halberd', 'halcyon',
  'harbor', 'harmony', 'harvest', 'hawthorn', 'heiress', 'hemlock', 'herald', 'heritage',
  'horizon', 'huntsman', 'imperial', 'indigo', 'infantry', 'ironwood', 'ivory', 'jacquard',
  'jade', 'jaguar', 'jasmine', 'jasper', 'javelin', 'jester', 'jubilee', 'juniper',
  'kestrel', 'kingdom', 'knight', 'labyrinth', 'lacquer', 'lagoon', 'lancer', 'lantern',
  'lapidary', 'laurel', 'lavender', 'legacy', 'legend', 'leopard', 'liberty', 'lineage',
  'mahogany', 'majesty', 'malachite', 'mandarin', 'manor', 'mantle', 'marigold', 'mariner',
  'marquis', 'marshal', 'masquerade', 'matador', 'meadow', 'medallion', 'mercury', 'meridian',
  'meteor', 'minaret', 'mirage', 'monarch', 'monolith', 'monsoon', 'mosaic', 'musket',
  'mustang', 'nautilus', 'nebula', 'nectar', 'nemesis', 'nightfall', 'noble', 'nomad',
  'obsidian', 'odyssey', 'olympus', 'omega', 'onyx', 'opulent', 'oracle', 'orchard',
  'orchid', 'osprey', 'outpost', 'overture', 'paladin', 'palazzo', 'panther', 'paragon',
  'parapet', 'parchment', 'pavilion', 'peacock', 'pegasus', 'pelican', 'pendulum', 'pennant',
  'peregrine', 'phantom', 'phoenix', 'pinnacle', 'pioneer', 'platinum', 'porcelain', 'portico',
  'prelude', 'prestige', 'prism', 'prodigy', 'prophecy', 'providence', 'quartz', 'quicksilver',
  'citrine', 'ierarchy', 'rapier', 'raven', 'regalia', 'regency', 'relic', 'renaissance',
  'reliquary', 'reverie', 'rhapsody', 'riviera', 'ierophant', 'rosewood', 'rubicon', 'ruby',
  'sabre', 'saffron', 'sanctuary', 'sapphire', 'satin', 'scepter', 'scimitar', 'sentinel',
  'serenade', 'seraph', 'sequoia', 'shadow', 'shamrock', 'silhouette', 'silver', 'solstice',
  'sovereign', 'specter', 'sphinx', 'stallion', 'starlight', 'sterling', 'summit', 'symphony',
  'talisman', 'tapestry', 'tempest', 'terrace', 'thistle', 'thunder', 'titanium', 'topaz',
  'tournament', 'trident', 'triumph', 'twilight', 'valkyrie', 'vanguard', 'vermillion', 'vesper',
  'viceroy', 'vintage', 'virtuoso', 'viscount', 'voyager', 'warden', 'whisper', 'zephyr',
];

const LOCAL_RECOVERY_HASH_KEY = 'kafkasino.recovery_hashes';

/**
 * Generates a cryptographically random 12-word recovery phrase using `window.crypto.getRandomValues`.
 */
export function generateRecoveryPhrase(): string[] {
  const randomBytes = new Uint8Array(12);
  window.crypto.getRandomValues(randomBytes);
  return Array.from(randomBytes, (b) => WORDLIST_256[b % WORDLIST_256.length]);
}

/**
 * Normalizes a recovery phrase string or word array:
 * lowercases, trims, and collapses any whitespace/punctuation separators to single spaces.
 */
export function normalizeRecoveryPhrase(input: string | readonly string[]): string {
  const raw = typeof input === 'string' ? input : input.join(' ');
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\r\n\t,;]+/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * Computes a deterministic SHA-256 hex digest of the normalized recovery phrase
 * in the browser before transmission, so the raw seed phrase never travels in plain text.
 * On the server, this digest is further salted & hashed with bcrypt (`pgcrypto`).
 */
export async function hashRecoveryPhraseClient(
  phrase: string | readonly string[],
): Promise<string> {
  const normalized = normalizeRecoveryPhrase(phrase);
  const payload = `kafkasino.recovery.v1:${normalized}`;
  const bytes = new TextEncoder().encode(payload);
  const digestBuffer = await window.crypto.subtle.digest('SHA-256', bytes as BufferSource);
  const digestArray = Array.from(new Uint8Array(digestBuffer));
  return digestArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Stores ONLY the irreversible SHA-256 hex digest for a username in localStorage
 * as a secondary verification record (never stores the raw phrase).
 */
export function saveLocalRecoveryHash(username: string, sha256HexDigest: string): void {
  try {
    const key = username.trim().toLowerCase();
    const raw = localStorage.getItem(LOCAL_RECOVERY_HASH_KEY);
    const map: Record<string, string> = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    map[key] = sha256HexDigest;
    localStorage.setItem(LOCAL_RECOVERY_HASH_KEY, JSON.stringify(map));
  } catch {
    /* localStorage unavailable */
  }
}

/**
 * Creates and triggers a `.txt` Blob download containing the username and 12-word recovery phrase.
 */
export function downloadRecoveryPhraseTxt(username: string, words: readonly string[]): void {
  const phraseFormatted = words
    .map((word, idx) => `${String(idx + 1).padStart(2, ' ')}. ${word}`)
    .join('\r\n');

  const content = [
    '============================================================',
    '            KAFKASINO — ACCOUNT RECOVERY KIT                ',
    '============================================================',
    '',
    `Username:   ${username}`,
    `Generated:  ${new Date().toISOString()}`,
    '',
    '12-WORD RECOVERY PHRASE (KEEP SECRET & OFFLINE):',
    '------------------------------------------------------------',
    phraseFormatted,
    '',
    'Single-Line Copy Format:',
    words.join(' '),
    '------------------------------------------------------------',
    '',
    'IMPORTANT SECURITY NOTICE:',
    '- Kafkasino uses pure Username authentication (no email).',
    '- Your Recovery Phrase is hashed (SHA-256 + bcrypt) and is',
    '  NEVER stored in plain text.',
    '- Anyone with this 12-word phrase can reset your password.',
    '- Store this file in a safe place.',
    '============================================================',
    '',
  ].join('\r\n');

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `kafkasino-recovery-${username.trim().toLowerCase()}.txt`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}
