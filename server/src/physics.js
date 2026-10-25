// Pure movement physics. No sockets, no timers, no mutation of inputs: every function returns
// new objects so the game loop (and tests) can reason about one step at a time.
//
// Tunables live here for now; they are candidates to move into shared/constants.js once the
// client needs them (e.g. PLAYER_RADIUS for rendering).

import { ARENA } from '@rumble/shared/constants';

/** Top speed reachable from tilt input alone, world units per second. */
export const MAX_SPEED = 320;
/** Acceleration at full tilt, world units per second squared. */
export const ACCEL = 1600;
/** Exponential velocity decay rate per second (v *= e^(-FRICTION * dt)). */
export const FRICTION = 3.5;
/** Collision radius of a player body, world units. */
export const PLAYER_RADIUS = 22;
/** Fraction of the closing speed bounced back when two players collide (0 = dead stop). */
export const BOUNCE = 0.6;
/** Spawn ring radius as a fraction of the platform radius. */
export const SPAWN_RING_FRACTION = 0.6;

/**
 * @typedef {object} Body
 * @property {string} id
 * @property {number} x
 * @property {number} y
 * @property {number} vx
 * @property {number} vy
 */

/**
 * Advance one body by `dt` seconds: accelerate along the input, apply friction, cap the speed,
 * then integrate position. No boundary clamping: leaving the platform is how you lose.
 * @template {Body} T
 * @param {T} player
 * @param {{ x: number, y: number }} input  Tilt vector, length <= 1 (see clampInputVector).
 * @param {number} dt seconds
 * @returns {T}
 */
export function stepPlayer(player, input, dt) {
  let vx = player.vx + input.x * ACCEL * dt;
  let vy = player.vy + input.y * ACCEL * dt;

  const decay = Math.exp(-FRICTION * dt);
  vx *= decay;
  vy *= decay;

  const speed = Math.hypot(vx, vy);
  if (speed > MAX_SPEED) {
    vx = (vx / speed) * MAX_SPEED;
    vy = (vy / speed) * MAX_SPEED;
  }

  return { ...player, vx, vy, x: player.x + vx * dt, y: player.y + vy * dt };
}

/**
 * Separate overlapping bodies (equal mass): each is pushed half the overlap along the line
 * between centers, and if they were closing in, the normal component of their relative
 * velocity is reflected with BOUNCE so a fast player shoves a slow one.
 * @template {Body} T
 * @param {T[]} bodies
 * @param {number} [radius]
 * @returns {T[]} new array of new objects, same order
 */
export function resolveCollisions(bodies, radius = PLAYER_RADIUS) {
  const out = bodies.map((b) => ({ ...b }));
  const minDist = radius * 2;

  for (let i = 0; i < out.length; i += 1) {
    for (let j = i + 1; j < out.length; j += 1) {
      const a = out[i];
      const b = out[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist >= minDist) continue;

      // Exactly coincident: pick a deterministic direction so they still separate.
      const nx = dist === 0 ? 1 : dx / dist;
      const ny = dist === 0 ? 0 : dy / dist;
      const push = (minDist - dist) / 2;

      a.x -= nx * push;
      a.y -= ny * push;
      b.x += nx * push;
      b.y += ny * push;

      const closing = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (closing < 0) {
        const impulse = (-(1 + BOUNCE) * closing) / 2;
        a.vx -= impulse * nx;
        a.vy -= impulse * ny;
        b.vx += impulse * nx;
        b.vy += impulse * ny;
      }
    }
  }
  return out;
}

/**
 * Evenly spaced spawn points on a ring inside the platform, starting at the top and going
 * clockwise. Index i is for the i-th player in join order.
 * @param {number} count
 * @param {{ centerX: number, centerY: number, platformRadius: number }} [arena]
 * @returns {{ x: number, y: number }[]}
 */
export function spawnPositions(count, arena = ARENA) {
  const ring = arena.platformRadius * SPAWN_RING_FRACTION;
  const points = [];
  for (let i = 0; i < count; i += 1) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    points.push({
      x: arena.centerX + Math.cos(angle) * ring,
      y: arena.centerY + Math.sin(angle) * ring,
    });
  }
  return points;
}
