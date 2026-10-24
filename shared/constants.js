// Game-wide constants shared by client and server.
// Values that are env-configurable are resolved on the server via resolvePlayerLimits().

export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 8;
/** Minimum players required to start when NODE_ENV=development. */
export const DEV_MIN_PLAYERS = 1;

/** Fixed server simulation rate (ticks per second). */
export const TICK_RATE = 30;
export const TICK_MS = 1000 / TICK_RATE;

/** Logical arena size in world units. The circular platform is centered. */
export const ARENA = Object.freeze({
  width: 960,
  height: 600,
  centerX: 480,
  centerY: 300,
  platformRadius: 250,
});

export const ROUND_SECONDS = 60;
export const COUNTDOWN_SECONDS = 3;
export const SHAKES_TO_CHARGE = 3;

/** Max player:input messages accepted per socket per second; excess is dropped. */
export const INPUT_RATE_LIMIT_PER_SEC = 30;
/** Grace period before a disconnected player counts as eliminated. */
export const RECONNECT_GRACE_MS = 15_000;

export const NAME_MAX_LENGTH = 12;
export const ROOM_CODE_LENGTH = 6;
/** Room code characters: uppercase, excluding look-alikes O/0/I/1. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** One color per player slot, in join order. Index = colorIndex. */
export const PLAYER_COLORS = Object.freeze([
  Object.freeze({ name: 'cyan', hex: '#22D3EE' }),
  Object.freeze({ name: 'pink', hex: '#F472B6' }),
  Object.freeze({ name: 'yellow', hex: '#FBBF24' }),
  Object.freeze({ name: 'green', hex: '#4ADE80' }),
  Object.freeze({ name: 'orange', hex: '#FB923C' }),
  Object.freeze({ name: 'blue', hex: '#3B82F6' }),
  Object.freeze({ name: 'red', hex: '#F43F5E' }),
  Object.freeze({ name: 'white', hex: '#F8FAFC' }),
]);

export const THEME = Object.freeze({
  background: '#090B1A',
  arena: '#151A35',
  primary: '#A855F7',
});

function readInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Resolve player limits from an env-like object (e.g. process.env).
 * MAX_PLAYERS is capped at PLAYER_COLORS.length so every player gets a unique color.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ minPlayers: number, maxPlayers: number, isDev: boolean }}
 */
export function resolvePlayerLimits(env = {}) {
  const maxPlayers = readInt(env.MAX_PLAYERS, MAX_PLAYERS, 1, PLAYER_COLORS.length);
  const isDev = env.NODE_ENV === 'development';
  const minPlayers = isDev
    ? readInt(env.DEV_MIN_PLAYERS, DEV_MIN_PLAYERS, 1, maxPlayers)
    : readInt(env.MIN_PLAYERS, MIN_PLAYERS, 1, maxPlayers);
  return { minPlayers, maxPlayers, isDev };
}
