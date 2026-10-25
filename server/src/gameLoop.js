// Server-authoritative simulation for one room. The simulation helpers (createGameState,
// stepGame, buildStatePayload) are pure apart from mutating the game state they are given; the
// timer helpers (startGameLoop / stopGameLoop) own the single interval stored on the room.

import { TICK_MS } from '@rumble/shared/constants';
import { resolveCollisions, spawnPositions, stepPlayer } from './physics.js';

/** At most this many fixed steps per interval callback, so a stalled process can't spiral. */
export const MAX_CATCH_UP_STEPS = 5;

const ZERO = Object.freeze({ x: 0, y: 0 });

/**
 * @typedef {object} GameBody
 * @property {string} id
 * @property {number} x
 * @property {number} y
 * @property {number} vx
 * @property {number} vy
 * @property {boolean} alive
 */

/**
 * @typedef {object} GameState
 * @property {number} tick
 * @property {GameBody[]} bodies   In join order.
 */

/** @param {import('./rooms.js').Room} room */
const playersInJoinOrder = (room) =>
  [...room.players.values()].sort((a, b) => a.joinOrder - b.joinOrder);

/**
 * Fresh round state: one body per player, spawned evenly on a ring in join order.
 * @param {import('./rooms.js').Room} room
 * @returns {GameState}
 */
export function createGameState(room) {
  const players = playersInJoinOrder(room);
  const spawns = spawnPositions(players.length);
  return {
    tick: 0,
    bodies: players.map((p, i) => ({
      id: p.id,
      x: spawns[i].x,
      y: spawns[i].y,
      vx: 0,
      vy: 0,
      alive: true,
    })),
  };
}

/**
 * Advance the simulation one fixed step. Disconnected players keep their body but get zero
 * input, so they coast to a stop and can still be pushed around.
 * @param {GameState} game  mutated: bodies replaced, tick incremented
 * @param {import('./rooms.js').Room} room
 * @param {(playerId: string) => { x: number, y: number }} getInput  latest stored input
 * @param {number} dt seconds
 */
export function stepGame(game, room, getInput, dt) {
  const moved = game.bodies.map((body) => {
    if (!body.alive) return body;
    const connected = room.players.get(body.id)?.connected ?? false;
    return stepPlayer(body, connected ? getInput(body.id) : ZERO, dt);
  });

  const alive = moved.filter((b) => b.alive);
  const separated = new Map(resolveCollisions(alive).map((b) => [b.id, b]));
  game.bodies = moved.map((b) => separated.get(b.id) ?? b);
  game.tick += 1;
}

const round1 = (n) => Math.round(n * 10) / 10 || 0; // `|| 0` turns -0 into 0

/**
 * game:state payload with numbers rounded to one decimal.
 * @param {GameState} game
 * @param {import('./rooms.js').Room} room
 * @param {{ now?: number, timeLeftMs?: number, getCharge?: (playerId: string) => number }} [options]
 * @returns {{ tick: number, serverTime: number, timeLeftMs: number,
 *             players: import('@rumble/shared/protocol').PlayerState[],
 *             events: import('@rumble/shared/protocol').GameEvent[] }}
 */
export function buildStatePayload(game, room, { now = Date.now(), timeLeftMs = 0, getCharge } = {}) {
  return {
    tick: game.tick,
    serverTime: now,
    timeLeftMs: Math.max(0, Math.round(timeLeftMs)),
    players: game.bodies.map((b) => ({
      id: b.id,
      x: round1(b.x),
      y: round1(b.y),
      vx: round1(b.vx),
      vy: round1(b.vy),
      charge: getCharge?.(b.id) ?? 0,
      alive: b.alive,
      connected: room.players.get(b.id)?.connected ?? false,
    })),
    events: [],
  };
}

/**
 * Start the room's fixed-timestep loop. Any loop already running on this room is stopped
 * first, so a room never has more than one. `step(dt)` runs once per fixed tick (possibly
 * several times per callback to catch up); `afterSteps()` runs once per callback in which at
 * least one step ran (used to broadcast the newest state).
 * @param {{ code: string, loop?: object | null }} room
 * @param {{ step: (dt: number) => void, afterSteps?: () => void, tickMs?: number,
 *           now?: () => number,
 *           timers?: { setInterval: typeof setInterval, clearInterval: typeof clearInterval } }} options
 */
export function startGameLoop(
  room,
  { step, afterSteps, tickMs = TICK_MS, now = () => performance.now(), timers = globalThis },
) {
  stopGameLoop(room);

  const dt = tickMs / 1000;
  let last = now();
  let accumulator = 0;

  const handle = timers.setInterval(() => {
    const current = now();
    accumulator += current - last;
    last = current;

    let steps = 0;
    while (accumulator >= tickMs && steps < MAX_CATCH_UP_STEPS) {
      step(dt);
      accumulator -= tickMs;
      steps += 1;
    }
    // Too far behind: drop the backlog instead of fast-forwarding the match.
    if (steps === MAX_CATCH_UP_STEPS) accumulator = Math.min(accumulator, tickMs);
    if (steps > 0) afterSteps?.();
  }, tickMs);

  room.loop = { handle, clear: () => timers.clearInterval(handle) };
  return room.loop;
}

/**
 * Stop and clear the room's loop, if any. Safe to call repeatedly.
 * @param {{ loop?: { clear: () => void } | null }} room
 * @returns {boolean} true if a loop was running
 */
export function stopGameLoop(room) {
  if (!room.loop) return false;
  room.loop.clear();
  room.loop = null;
  return true;
}
