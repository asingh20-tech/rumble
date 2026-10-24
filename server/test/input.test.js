import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as connect } from 'socket.io-client';
import { EVENTS } from '@rumble/shared/protocol';
import { INPUT_RATE_LIMIT_PER_SEC, SHAKES_TO_CHARGE } from '@rumble/shared/constants';
import {
  INPUT_STALE_MS,
  SHAKE_MIN_INTERVAL_MS,
  applyInput,
  applyShake,
  clampInputVector,
  createInputStore,
  createRateLimiter,
  parseInput,
  parseShake,
  readInput,
  resetCharge,
  startInputSession,
  takeInputSummary,
} from '../src/input.js';
import { createRumbleServer } from '../src/index.js';

describe('input validation', () => {
  it('accepts in-range input unchanged', () => {
    expect(parseInput({ x: 0.5, y: -0.25, seq: 0 })).toEqual({ x: 0.5, y: -0.25, seq: 0 });
    expect(parseInput({ x: 0, y: 1, seq: 42 })).toEqual({ x: 0, y: 1, seq: 42 });
  });

  it('clamps each axis to [-1, 1]', () => {
    expect(parseInput({ x: 5, y: 0, seq: 1 })).toEqual({ x: 1, y: 0, seq: 1 });
    expect(parseInput({ x: 0, y: -9, seq: 1 })).toEqual({ x: 0, y: -1, seq: 1 });
  });

  it('normalizes vectors longer than 1', () => {
    const { x, y } = parseInput({ x: 1, y: 1, seq: 1 });
    expect(Math.hypot(x, y)).toBeCloseTo(1, 10);
    expect(x).toBeCloseTo(Math.SQRT1_2, 10);
    expect(y).toBeCloseTo(Math.SQRT1_2, 10);
    const big = clampInputVector(-30, 40);
    expect(Math.hypot(big.x, big.y)).toBeCloseTo(1, 10);
    expect(big.x).toBeLessThan(0);
    expect(big.y).toBeGreaterThan(0);
  });

  it('rejects non-numbers, non-finite values and bad seqs', () => {
    for (const bad of [
      null,
      undefined,
      'x',
      42,
      [0, 0, 1],
      {},
      { x: '0.5', y: 0, seq: 1 },
      { x: 0, y: null, seq: 1 },
      { x: NaN, y: 0, seq: 1 },
      { x: Infinity, y: 0, seq: 1 },
      { x: 0, y: -Infinity, seq: 1 },
      { x: 0, y: 0 },
      { x: 0, y: 0, seq: -1 },
      { x: 0, y: 0, seq: 1.5 },
      { x: 0, y: 0, seq: '3' },
      { x: 0, y: 0, seq: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(parseInput(bad)).toBeNull();
    }
  });

  it('validates shake payloads', () => {
    expect(parseShake({ seq: 0 })).toEqual({ seq: 0 });
    expect(parseShake({ seq: 7, extra: true })).toEqual({ seq: 7 });
    for (const bad of [null, {}, { seq: -1 }, { seq: 1.2 }, { seq: '1' }, [1]]) {
      expect(parseShake(bad)).toBeNull();
    }
  });
});

describe('rate limiter', () => {
  it('allows `limit` calls per window and drops the excess', () => {
    const limiter = createRateLimiter({ limit: 30, windowMs: 1000 });
    let allowed = 0;
    for (let i = 0; i < 50; i += 1) if (limiter.tryAcquire(1000)) allowed += 1;
    expect(allowed).toBe(30);
    expect(limiter.tryAcquire(1999)).toBe(false);
    expect(limiter.tryAcquire(2000)).toBe(true);
  });

  it('is a sliding window, not a fixed one', () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000 });
    expect(limiter.tryAcquire(0)).toBe(true);
    expect(limiter.tryAcquire(400)).toBe(true);
    expect(limiter.tryAcquire(800)).toBe(true);
    // A fixed window would reset at 1000 and allow a burst; sliding only frees the t=0 slot.
    expect(limiter.tryAcquire(1000)).toBe(true);
    expect(limiter.tryAcquire(1001)).toBe(false);
    expect(limiter.tryAcquire(1400)).toBe(true);
  });

  it('never exceeds the limit in any 1s span at a steady 60 msgs/s', () => {
    const limiter = createRateLimiter({ limit: INPUT_RATE_LIMIT_PER_SEC });
    const accepted = [];
    for (let t = 0; t < 5000; t += 1000 / 60) if (limiter.tryAcquire(t)) accepted.push(t);
    for (const start of accepted) {
      const inWindow = accepted.filter((t) => t >= start && t < start + 1000).length;
      expect(inWindow).toBeLessThanOrEqual(INPUT_RATE_LIMIT_PER_SEC);
    }
    expect(accepted.length).toBeGreaterThanOrEqual(INPUT_RATE_LIMIT_PER_SEC * 4);
  });
});

describe('input store', () => {
  it('stores the latest input and ignores stale or repeated seqs', () => {
    const store = createInputStore();
    startInputSession(store, 'p1');
    expect(applyInput(store, 'p1', { x: 0.1, y: 0.2, seq: 5 }, 1000)).toBe(true);
    expect(applyInput(store, 'p1', { x: 0.9, y: 0.9, seq: 4 }, 1001)).toBe(false);
    expect(applyInput(store, 'p1', { x: 0.9, y: 0.9, seq: 5 }, 1001)).toBe(false);
    expect(readInput(store, 'p1', 1010)).toEqual({ x: 0.1, y: 0.2 });
    expect(applyInput(store, 'unknown', { x: 1, y: 0, seq: 1 }, 1000)).toBe(false);
  });

  it('reads stale or missing input as zero', () => {
    const store = createInputStore();
    expect(readInput(store, 'nobody', 0)).toEqual({ x: 0, y: 0 });
    startInputSession(store, 'p1');
    expect(readInput(store, 'p1', 0)).toEqual({ x: 0, y: 0 });
    applyInput(store, 'p1', { x: 1, y: 0, seq: 0 }, 1000);
    expect(readInput(store, 'p1', 1000 + INPUT_STALE_MS)).toEqual({ x: 1, y: 0 });
    expect(readInput(store, 'p1', 1001 + INPUT_STALE_MS)).toEqual({ x: 0, y: 0 });
  });

  it('a new session (rejoin / reload) restarts seq tracking but keeps charge', () => {
    const store = createInputStore();
    startInputSession(store, 'p1');
    applyInput(store, 'p1', { x: 1, y: 0, seq: 900 }, 0);
    applyShake(store, 'p1', 50, { now: 0, charging: true });
    startInputSession(store, 'p1');
    expect(applyInput(store, 'p1', { x: 0.5, y: 0, seq: 0 }, 10)).toBe(true);
    expect(applyShake(store, 'p1', 0, { now: 1000, charging: true })).toEqual({
      accepted: true,
      charge: 2,
    });
  });

  it('summarizes once and resets counters; idle players produce no line', () => {
    const store = createInputStore();
    startInputSession(store, 'p1');
    const state = store.get('p1');
    expect(takeInputSummary(state, 'Ann', 0)).toBeNull();
    applyInput(store, 'p1', { x: 0.5, y: -0.25, seq: 3 }, 100);
    applyInput(store, 'p1', { x: 0.5, y: -0.25, seq: 2 }, 100);
    const line = takeInputSummary(state, 'Ann', 200);
    expect(line).toContain('Ann');
    expect(line).toContain('x=+0.50 y=-0.25 seq=3');
    expect(line).toContain('recv=1/s drop=1');
    expect(takeInputSummary(state, 'Ann', 300)).toBeNull();
  });
});

describe('shake dedupe', () => {
  const setup = () => {
    const store = createInputStore();
    startInputSession(store, 'p1');
    return store;
  };

  it('ignores a seq that is not greater than the last one', () => {
    const store = setup();
    expect(applyShake(store, 'p1', 1, { now: 0 }).accepted).toBe(true);
    expect(applyShake(store, 'p1', 1, { now: 1000 })).toMatchObject({
      accepted: false,
      reason: 'duplicate',
    });
    expect(applyShake(store, 'p1', 0, { now: 2000 })).toMatchObject({
      accepted: false,
      reason: 'duplicate',
    });
    expect(applyShake(store, 'p1', 2, { now: 3000 }).accepted).toBe(true);
  });

  it('enforces a minimum interval between accepted shakes', () => {
    const store = setup();
    expect(applyShake(store, 'p1', 0, { now: 1000 }).accepted).toBe(true);
    expect(applyShake(store, 'p1', 1, { now: 1000 + SHAKE_MIN_INTERVAL_MS - 1 })).toMatchObject({
      accepted: false,
      reason: 'too-soon',
    });
    // The too-soon seq is consumed, so a retransmit of it never counts later.
    expect(applyShake(store, 'p1', 1, { now: 5000 }).reason).toBe('duplicate');
    expect(applyShake(store, 'p1', 2, { now: 1000 + SHAKE_MIN_INTERVAL_MS }).accepted).toBe(true);
  });

  it('charges only while playing, capped at SHAKES_TO_CHARGE, and resets', () => {
    const store = setup();
    expect(applyShake(store, 'p1', 0, { now: 0, charging: false })).toEqual({
      accepted: true,
      charge: 0,
    });
    let charge = 0;
    for (let i = 1; i <= SHAKES_TO_CHARGE + 2; i += 1) {
      ({ charge } = applyShake(store, 'p1', i, { now: i * 1000, charging: true }));
    }
    expect(charge).toBe(SHAKES_TO_CHARGE);
    resetCharge(store, 'p1');
    expect(applyShake(store, 'p1', 99, { now: 99_000, charging: true }).charge).toBe(1);
  });

  it('rejects shakes for unknown players', () => {
    expect(applyShake(createInputStore(), 'ghost', 0)).toMatchObject({
      accepted: false,
      reason: 'unknown',
    });
  });
});

describe('input over sockets', () => {
  let server;
  let baseUrl;
  const clients = [];

  const open = async () => {
    const c = connect(baseUrl, { transports: ['websocket'], forceNew: true });
    clients.push(c);
    await new Promise((resolve, reject) => {
      c.once('connect', resolve);
      c.once('connect_error', reject);
    });
    return c;
  };
  const call = (c, event, payload) => c.timeout(2000).emitWithAck(event, payload);
  const settle = () => new Promise((r) => setTimeout(r, 100));

  beforeAll(async () => {
    server = createRumbleServer({ env: { NODE_ENV: 'test', MIN_PLAYERS: '1' } });
    await new Promise((resolve) => server.httpServer.listen(0, resolve));
    baseUrl = `http://localhost:${server.httpServer.address().port}`;
  });

  afterAll(async () => {
    for (const c of clients) c.disconnect();
    await new Promise((resolve) => server.io.close(resolve));
  });

  const joinRoom = async () => {
    const host = await open();
    const { room } = await call(host, EVENTS.ROOM_CREATE, {});
    const phone = await open();
    const joined = await call(phone, EVENTS.ROOM_JOIN, { code: room.code, name: 'Tilt' });
    return { phone, playerId: joined.playerId };
  };

  it('stores validated, clamped input and drops input from unjoined sockets', async () => {
    const stranger = await open();
    stranger.emit(EVENTS.PLAYER_INPUT, { x: 1, y: 0, seq: 1 });

    const { phone, playerId } = await joinRoom();
    phone.emit(EVENTS.PLAYER_INPUT, { x: 0.9, y: -0.9, seq: 1 });
    phone.emit(EVENTS.PLAYER_INPUT, { x: 'left', y: 0, seq: 2 });
    await settle();
    const state = server.inputs.get(playerId);
    expect(state.seq).toBe(1);
    expect(state.x).toBeCloseTo(Math.SQRT1_2, 10);
    expect(state.y).toBeCloseTo(-Math.SQRT1_2, 10);
    expect(stranger.connected).toBe(true);
  });

  it('rate-limits player:input to 30 per second per socket', async () => {
    const { phone, playerId } = await joinRoom();
    for (let seq = 0; seq < 60; seq += 1) {
      phone.emit(EVENTS.PLAYER_INPUT, { x: 0.1, y: 0, seq });
    }
    await settle();
    const state = server.inputs.get(playerId);
    expect(state.stats.received).toBe(INPUT_RATE_LIMIT_PER_SEC);
    expect(state.seq).toBe(INPUT_RATE_LIMIT_PER_SEC - 1);
  });

  it('dedupes shakes by seq and acks the result', async () => {
    const { phone } = await joinRoom();
    expect(await call(phone, EVENTS.PLAYER_SHAKE, { seq: 0 })).toEqual({
      ok: true,
      accepted: true,
      charge: 0,
    });
    expect(await call(phone, EVENTS.PLAYER_SHAKE, { seq: 0 })).toMatchObject({
      ok: true,
      accepted: false,
    });
    expect(await call(phone, EVENTS.PLAYER_SHAKE, { seq: -3 })).toMatchObject({
      ok: false,
      code: 'BAD_INPUT',
    });
    const stranger = await open();
    expect(await call(stranger, EVENTS.PLAYER_SHAKE, { seq: 0 })).toMatchObject({
      ok: false,
      code: 'BAD_INPUT',
    });
  });
});
