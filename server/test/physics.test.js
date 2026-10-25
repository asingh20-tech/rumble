import { describe, it, expect } from 'vitest';
import { ARENA, TICK_MS } from '@rumble/shared/constants';
import {
  MAX_SPEED,
  PLAYER_RADIUS,
  SPAWN_RING_FRACTION,
  resolveCollisions,
  spawnPositions,
  stepPlayer,
} from '../src/physics.js';

const DT = TICK_MS / 1000;
const body = (over = {}) => ({ id: 'p', x: 480, y: 300, vx: 0, vy: 0, ...over });
const speed = (b) => Math.hypot(b.vx, b.vy);

describe('stepPlayer', () => {
  it('accelerates along the input and moves the body', () => {
    const next = stepPlayer(body(), { x: 1, y: 0 }, DT);
    expect(next.vx).toBeGreaterThan(0);
    expect(next.vy).toBe(0);
    expect(next.x).toBeGreaterThan(480);
  });

  it('never exceeds MAX_SPEED, even with a huge starting velocity', () => {
    let b = body();
    for (let i = 0; i < 300; i += 1) {
      b = stepPlayer(b, { x: Math.SQRT1_2, y: Math.SQRT1_2 }, DT);
      expect(speed(b)).toBeLessThanOrEqual(MAX_SPEED + 1e-9);
    }
    expect(speed(b)).toBeCloseTo(MAX_SPEED, 5);
    expect(speed(stepPlayer(body({ vx: 5000, vy: -5000 }), { x: 0, y: 0 }, DT))).toBeCloseTo(
      MAX_SPEED,
      5,
    );
  });

  it('friction decays velocity toward zero without input', () => {
    let b = body({ vx: 200, vy: -100 });
    let previous = speed(b);
    for (let i = 0; i < 90; i += 1) {
      b = stepPlayer(b, { x: 0, y: 0 }, DT);
      expect(speed(b)).toBeLessThan(previous);
      previous = speed(b);
    }
    expect(previous).toBeLessThan(1);
    // Direction is preserved while decaying.
    expect(b.vx / b.vy).toBeCloseTo(-2, 5);
  });

  it('does not clamp to the platform or arena', () => {
    const b = stepPlayer(body({ x: ARENA.width - 1, vx: MAX_SPEED }), { x: 1, y: 0 }, 1);
    expect(b.x).toBeGreaterThan(ARENA.width);
  });

  it('is pure', () => {
    const b = body({ vx: 10 });
    const snapshot = { ...b };
    stepPlayer(b, { x: 1, y: 1 }, DT);
    expect(b).toEqual(snapshot);
  });
});

describe('resolveCollisions', () => {
  it('separates overlapping bodies to exactly two radii, symmetrically', () => {
    const a = body({ id: 'a', x: 100, y: 100 });
    const b = body({ id: 'b', x: 110, y: 100 });
    const [na, nb] = resolveCollisions([a, b]);
    expect(Math.hypot(nb.x - na.x, nb.y - na.y)).toBeCloseTo(PLAYER_RADIUS * 2, 9);
    expect((na.x + nb.x) / 2).toBeCloseTo(105, 9);
    expect(a.x).toBe(100); // inputs untouched
  });

  it('separates exactly coincident bodies', () => {
    const [na, nb] = resolveCollisions([body({ id: 'a' }), body({ id: 'b' })]);
    expect(Math.hypot(nb.x - na.x, nb.y - na.y)).toBeCloseTo(PLAYER_RADIUS * 2, 9);
  });

  it('leaves non-overlapping bodies alone', () => {
    const a = body({ id: 'a', x: 0, vx: 5 });
    const b = body({ id: 'b', x: PLAYER_RADIUS * 2 + 1 });
    expect(resolveCollisions([a, b])).toEqual([a, b]);
  });

  it('transfers momentum from a charging player to a resting one', () => {
    const a = body({ id: 'a', x: 100, vx: 300 });
    const b = body({ id: 'b', x: 140, vx: 0 });
    const [na, nb] = resolveCollisions([a, b]);
    expect(nb.vx).toBeGreaterThan(0);
    expect(na.vx).toBeLessThan(300);
    expect(na.vx + nb.vx).toBeCloseTo(300, 9); // equal mass: momentum conserved
  });
});

describe('spawnPositions', () => {
  it('places players evenly on a ring inside the platform, first at the top', () => {
    const ring = ARENA.platformRadius * SPAWN_RING_FRACTION;
    const points = spawnPositions(4);
    expect(points).toHaveLength(4);
    const expected = [
      { x: 480, y: 300 - ring },
      { x: 480 + ring, y: 300 },
      { x: 480, y: 300 + ring },
      { x: 480 - ring, y: 300 },
    ];
    points.forEach((p, i) => {
      expect(p.x).toBeCloseTo(expected[i].x, 9);
      expect(p.y).toBeCloseTo(expected[i].y, 9);
    });
  });

  it('keeps every spawn inside the platform without overlapping, up to 8 players', () => {
    const points = spawnPositions(8);
    for (const p of points) {
      const r = Math.hypot(p.x - ARENA.centerX, p.y - ARENA.centerY);
      expect(r + PLAYER_RADIUS).toBeLessThan(ARENA.platformRadius);
    }
    for (let i = 0; i < points.length; i += 1) {
      const n = points[(i + 1) % points.length];
      expect(Math.hypot(n.x - points[i].x, n.y - points[i].y)).toBeGreaterThan(PLAYER_RADIUS * 2);
    }
  });
});
