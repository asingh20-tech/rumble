import { describe, it, expect, vi, afterEach } from 'vitest';
import { TICK_MS, TICK_RATE } from '@rumble/shared/constants';
import {
  buildStatePayload,
  createGameState,
  startGameLoop,
  stepGame,
  stopGameLoop,
} from '../src/gameLoop.js';
import { spawnPositions } from '../src/physics.js';

function makeRoom(players) {
  return {
    code: 'TEST42',
    loop: null,
    players: new Map(players.map((p) => [p.id, { connected: true, ...p }])),
  };
}

describe('game state', () => {
  it('spawns bodies on the ring in join order', () => {
    const room = makeRoom([
      { id: 'c', joinOrder: 2 },
      { id: 'a', joinOrder: 0 },
      { id: 'b', joinOrder: 1 },
    ]);
    const game = createGameState(room);
    const spawns = spawnPositions(3);
    expect(game.tick).toBe(0);
    expect(game.bodies.map((b) => b.id)).toEqual(['a', 'b', 'c']);
    game.bodies.forEach((b, i) => {
      expect(b).toMatchObject({ x: spawns[i].x, y: spawns[i].y, vx: 0, vy: 0, alive: true });
    });
  });

  it('moves connected players by their input and gives disconnected players zero input', () => {
    const room = makeRoom([
      { id: 'on', joinOrder: 0 },
      { id: 'off', joinOrder: 1, connected: false },
    ]);
    const game = createGameState(room);
    const start = game.bodies.map((b) => ({ ...b }));
    const getInput = vi.fn(() => ({ x: 1, y: 0 }));
    for (let i = 0; i < 5; i += 1) stepGame(game, room, getInput, TICK_MS / 1000);

    expect(game.tick).toBe(5);
    expect(game.bodies[0].x).toBeGreaterThan(start[0].x);
    expect(game.bodies[1]).toMatchObject({ x: start[1].x, y: start[1].y, vx: 0, vy: 0 });
    expect(getInput).not.toHaveBeenCalledWith('off');
  });

  it('builds a game:state payload rounded to one decimal', () => {
    const room = makeRoom([{ id: 'a', joinOrder: 0, connected: false }]);
    const game = {
      tick: 7,
      bodies: [{ id: 'a', x: 1.26, y: 2.24, vx: -0.05, vy: 10.04999, alive: true }],
    };
    expect(buildStatePayload(game, room, { now: 123, getCharge: () => 2 })).toEqual({
      tick: 7,
      serverTime: 123,
      timeLeftMs: 0,
      players: [{ id: 'a', x: 1.3, y: 2.2, vx: 0, vy: 10, charge: 2, alive: true, connected: false }],
      events: [],
    });
  });
});

describe('game loop timer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs TICK_RATE fixed steps per second and broadcasts after each', () => {
    vi.useFakeTimers();
    const room = makeRoom([]);
    const step = vi.fn();
    const afterSteps = vi.fn();
    startGameLoop(room, { step, afterSteps, now: () => Date.now() });

    // Timer periods are whole milliseconds, so the step count may trail real time by one tick.
    vi.advanceTimersByTime(3000);
    expect(step.mock.calls.length).toBeGreaterThanOrEqual(3 * TICK_RATE - 1);
    expect(step.mock.calls.length).toBeLessThanOrEqual(3 * TICK_RATE);
    expect(step).toHaveBeenCalledWith(TICK_MS / 1000);
    expect(afterSteps.mock.calls.length).toBeGreaterThan(0);
    expect(afterSteps.mock.calls.length).toBeLessThanOrEqual(step.mock.calls.length);
    stopGameLoop(room);
  });

  it('starting twice leaves exactly one loop running', () => {
    vi.useFakeTimers();
    const room = makeRoom([]);
    const first = vi.fn();
    const second = vi.fn();
    startGameLoop(room, { step: first, now: () => Date.now() });
    const firstLoop = room.loop;
    startGameLoop(room, { step: second, now: () => Date.now() });

    expect(room.loop).not.toBe(firstLoop);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(first).not.toHaveBeenCalled();
    expect(second.mock.calls.length).toBeGreaterThanOrEqual(TICK_RATE - 1);
    expect(second.mock.calls.length).toBeLessThanOrEqual(TICK_RATE);

    expect(stopGameLoop(room)).toBe(true);
    expect(room.loop).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(stopGameLoop(room)).toBe(false);
  });

  it('catches up after a stall but caps the burst', () => {
    vi.useFakeTimers();
    const room = makeRoom([]);
    let clock = 0;
    const step = vi.fn();
    startGameLoop(room, { step, now: () => clock });

    clock = 10_000; // process stalled for 10s
    vi.advanceTimersByTime(TICK_MS);
    expect(step).toHaveBeenCalledTimes(5);
    stopGameLoop(room);
  });
});
