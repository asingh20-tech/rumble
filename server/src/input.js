// Pure controller-input logic: payload validation, per-socket rate limiting, latest input per
// player and shake dedupe. No sockets and no timers: index.js wires these to Socket.IO events,
// and the game loop reads the stored input with readInput().

import { SHAKES_TO_CHARGE } from '@rumble/shared/constants';

/**
 * Minimum time between two accepted shakes from one player. The phone applies a 400ms
 * cooldown; the server allows some network jitter on top of that.
 */
export const SHAKE_MIN_INTERVAL_MS = 300;
/** player:shake messages accepted per socket per second before RATE_LIMITED. */
export const SHAKE_RATE_LIMIT_PER_SEC = 10;
/**
 * Phones send at least every 100ms while active. Input older than this is treated as
 * "no input" so a phone that locks or loses signal doesn't keep its player moving.
 */
export const INPUT_STALE_MS = 500;

const ZERO = Object.freeze({ x: 0, y: 0 });

const isSeq = (value) => Number.isSafeInteger(value) && value >= 0;
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Clamp each axis to [-1, 1], then scale the vector down so its length is at most 1.
 * @param {number} x
 * @param {number} y
 * @returns {{ x: number, y: number }}
 */
export function clampInputVector(x, y) {
  let cx = Math.min(1, Math.max(-1, x));
  let cy = Math.min(1, Math.max(-1, y));
  const length = Math.hypot(cx, cy);
  if (length > 1) {
    cx /= length;
    cy /= length;
  }
  return { x: cx, y: cy };
}

/**
 * Validate a player:input payload. Returns null for anything malformed.
 * @param {unknown} payload expected { x: number, y: number, seq: number }
 * @returns {{ x: number, y: number, seq: number } | null}
 */
export function parseInput(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const { x, y, seq } = payload;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isSeq(seq)) return null;
  return { ...clampInputVector(x, y), seq };
}

/**
 * Validate a player:shake payload. Returns null for anything malformed.
 * @param {unknown} payload expected { seq: number }
 * @returns {{ seq: number } | null}
 */
export function parseShake(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return isSeq(payload.seq) ? { seq: payload.seq } : null;
}

/**
 * Sliding-window rate limiter: at most `limit` accepted calls in any `windowMs` span.
 * Keeps the timestamps of the last `limit` accepted calls in a ring buffer.
 * @param {{ limit: number, windowMs?: number }} options
 */
export function createRateLimiter({ limit, windowMs = 1000 }) {
  const stamps = new Array(limit).fill(Number.NEGATIVE_INFINITY);
  let oldest = 0;
  return {
    /**
     * @param {number} [now]
     * @returns {boolean} true if the call is allowed (and counted)
     */
    tryAcquire(now = Date.now()) {
      if (now - stamps[oldest] < windowMs) return false;
      stamps[oldest] = now;
      oldest = (oldest + 1) % limit;
      return true;
    },
  };
}

/**
 * @typedef {object} InputState
 * @property {number} x
 * @property {number} y
 * @property {number} seq            Last accepted player:input seq (-1 = none this session).
 * @property {number} receivedAt     When the last input was accepted (-Infinity = never).
 * @property {number} shakeSeq       Last seen player:shake seq (-1 = none this session).
 * @property {number} lastShakeAt    When the last shake was accepted.
 * @property {number} charge         0..SHAKES_TO_CHARGE, only grows while playing.
 * @property {{ received: number, dropped: number, shakes: number }} stats  Since last log.
 */

/** @returns {Map<string, InputState>} keyed by playerId */
export function createInputStore() {
  return new Map();
}

const emptyStats = () => ({ received: 0, dropped: 0, shakes: 0 });

/**
 * Start (or restart) a player's input session after join/rejoin. A new socket or a reloaded
 * page starts its seq counters again, so the dedupe state resets; charge is kept.
 * @param {Map<string, InputState>} store
 * @param {string} playerId
 */
export function startInputSession(store, playerId) {
  const previous = store.get(playerId);
  store.set(playerId, {
    x: 0,
    y: 0,
    seq: -1,
    receivedAt: Number.NEGATIVE_INFINITY,
    shakeSeq: -1,
    lastShakeAt: Number.NEGATIVE_INFINITY,
    charge: previous?.charge ?? 0,
    stats: previous?.stats ?? emptyStats(),
  });
}

/**
 * @param {Map<string, InputState>} store
 * @param {string} playerId
 */
export function removeInputState(store, playerId) {
  store.delete(playerId);
}

/**
 * Store a validated input as the player's latest. Out-of-order or repeated seqs are ignored.
 * @param {Map<string, InputState>} store
 * @param {string} playerId
 * @param {{ x: number, y: number, seq: number }} input from parseInput()
 * @param {number} [now]
 * @returns {boolean} true if stored
 */
export function applyInput(store, playerId, input, now = Date.now()) {
  const state = store.get(playerId);
  if (!state) return false;
  if (input.seq <= state.seq) {
    state.stats.dropped += 1;
    return false;
  }
  state.x = input.x;
  state.y = input.y;
  state.seq = input.seq;
  state.receivedAt = now;
  state.stats.received += 1;
  return true;
}

/**
 * Count one dropped message against a player (rate limited or malformed).
 * @param {Map<string, InputState>} store
 * @param {string} playerId
 */
export function countDropped(store, playerId) {
  const state = store.get(playerId);
  if (state) state.stats.dropped += 1;
}

/**
 * Deduplicate a shake. A seq not greater than the last seen one is a duplicate; a new seq
 * arriving within SHAKE_MIN_INTERVAL_MS of the last accepted shake is too soon. Accepted
 * shakes add charge (capped at SHAKES_TO_CHARGE) only when `charging` is true, i.e. while
 * a round is being played.
 * @param {Map<string, InputState>} store
 * @param {string} playerId
 * @param {number} seq
 * @param {{ now?: number, charging?: boolean }} [options]
 * @returns {{ accepted: boolean, charge: number, reason?: 'unknown'|'duplicate'|'too-soon' }}
 */
export function applyShake(store, playerId, seq, { now = Date.now(), charging = false } = {}) {
  const state = store.get(playerId);
  if (!state) return { accepted: false, charge: 0, reason: 'unknown' };
  if (seq <= state.shakeSeq) return { accepted: false, charge: state.charge, reason: 'duplicate' };
  state.shakeSeq = seq;
  if (now - state.lastShakeAt < SHAKE_MIN_INTERVAL_MS) {
    return { accepted: false, charge: state.charge, reason: 'too-soon' };
  }
  state.lastShakeAt = now;
  state.stats.shakes += 1;
  if (charging) state.charge = Math.min(SHAKES_TO_CHARGE, state.charge + 1);
  return { accepted: true, charge: state.charge };
}

/**
 * Reset a player's charge to 0 (after an attack, or at the start of a round).
 * @param {Map<string, InputState>} store
 * @param {string} playerId
 */
export function resetCharge(store, playerId) {
  const state = store.get(playerId);
  if (state) state.charge = 0;
}

/**
 * The input the simulation should use for a player right now. Missing or stale input reads
 * as zero.
 * @param {Map<string, InputState>} store
 * @param {string} playerId
 * @param {number} [now]
 * @returns {{ x: number, y: number }}
 */
export function readInput(store, playerId, now = Date.now()) {
  const state = store.get(playerId);
  if (!state || now - state.receivedAt > INPUT_STALE_MS) return ZERO;
  return { x: state.x, y: state.y };
}

/**
 * One-line summary of a player's input since the last call, then reset the counters.
 * Returns null if nothing happened, so idle players don't spam the log.
 * @param {InputState} state
 * @param {string} name
 * @param {number} [now]
 * @returns {string | null}
 */
export function takeInputSummary(state, name, now = Date.now()) {
  const { received, dropped, shakes } = state.stats;
  state.stats = emptyStats();
  if (received === 0 && dropped === 0 && shakes === 0) return null;
  const fmt = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);
  const stale = now - state.receivedAt > INPUT_STALE_MS ? ' (stale)' : '';
  return (
    `input ${name}: x=${fmt(state.x)} y=${fmt(state.y)} seq=${state.seq}${stale} ` +
    `recv=${received}/s drop=${dropped} shakes=${shakes} charge=${state.charge}`
  );
}
