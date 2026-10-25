import { describe, it, expect, beforeEach } from 'vitest';
import { ERROR_CODES } from '@rumble/shared/protocol';
import {
  NAME_MAX_LENGTH,
  RECONNECT_GRACE_MS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from '@rumble/shared/constants';
import {
  canStart,
  createRoom,
  createRoomStore,
  deleteRoom,
  disconnectSocket,
  expirePlayer,
  generateRoomCode,
  isHostExpired,
  joinRoom,
  normalizeRoomCode,
  reclaimHost,
  rejoinRoom,
  sanitizeName,
  startGame,
  toSnapshot,
} from '../src/rooms.js';

const LIMITS = { minPlayers: 2, maxPlayers: 4 };

function setup(limits = LIMITS) {
  const store = createRoomStore();
  const { room } = createRoom(store, { socketId: 'host', limits });
  const join = (socketId, name = socketId) => joinRoom(store, { socketId, code: room.code, name });
  return { store, room, join };
}

describe('room creation', () => {
  it('creates a lobby with a valid 6-char code', () => {
    const { room } = setup();
    expect(room.code).toHaveLength(ROOM_CODE_LENGTH);
    expect([...room.code].every((c) => ROOM_CODE_ALPHABET.includes(c))).toBe(true);
    expect(room.phase).toBe('lobby');
    expect(room.hostSocketId).toBe('host');
    expect(toSnapshot(room)).toEqual({
      code: room.code,
      phase: 'lobby',
      players: [],
      minPlayers: 2,
      maxPlayers: 4,
      round: 0,
      canStart: false,
    });
  });

  it('generates unique codes across many rooms', () => {
    const store = createRoomStore();
    for (let i = 0; i < 500; i += 1) {
      expect(createRoom(store, { socketId: `h${i}`, limits: LIMITS }).ok).toBe(true);
    }
    expect(store.rooms.size).toBe(500);
  });

  it('retries on code collisions', () => {
    const store = createRoomStore();
    // First room gets AAAAAA; the second create sees AAAAAA again, then BBBBBB.
    const seq = [...Array(6).fill(0), ...Array(6).fill(0), ...Array(6).fill(1)];
    const pick = () => seq.shift();
    const a = createRoom(store, { socketId: 'h1', limits: LIMITS, pick });
    const b = createRoom(store, { socketId: 'h2', limits: LIMITS, pick });
    expect(a.room.code).toBe('AAAAAA');
    expect(b.room.code).toBe('BBBBBB');
  });

  it('is idempotent for the same host socket', () => {
    const store = createRoomStore();
    const a = createRoom(store, { socketId: 'h', limits: LIMITS });
    const b = createRoom(store, { socketId: 'h', limits: LIMITS });
    expect(b.room).toBe(a.room);
    expect(b.created).toBe(false);
    expect(store.rooms.size).toBe(1);
  });

  it('generateRoomCode uses only the alphabet', () => {
    expect(generateRoomCode(() => 0)).toBe('AAAAAA');
    expect(generateRoomCode()).toMatch(new RegExp(`^[${ROOM_CODE_ALPHABET}]{6}$`));
  });
});

describe('joining', () => {
  it('assigns ids, tokens, colors and join order', () => {
    const { room, join } = setup();
    const a = join('s1', 'Ann');
    const b = join('s2', 'Ben');
    expect(a.ok && b.ok).toBe(true);
    expect(a.player.id).not.toBe(b.player.id);
    expect(a.player.reconnectToken).toEqual(expect.any(String));
    expect([a.player.colorIndex, b.player.colorIndex]).toEqual([0, 1]);
    expect([a.player.joinOrder, b.player.joinOrder]).toEqual([0, 1]);
    const snap = toSnapshot(room);
    expect(snap.players.map((p) => p.name)).toEqual(['Ann', 'Ben']);
    expect(snap.canStart).toBe(true);
    expect(JSON.stringify(snap)).not.toContain(a.player.reconnectToken);
  });

  it('accepts lowercase codes with whitespace', () => {
    const { store, room } = setup();
    const r = joinRoom(store, { socketId: 's', code: ` ${room.code.toLowerCase()} `, name: 'X' });
    expect(r.ok).toBe(true);
  });

  it('rejects unknown and malformed codes', () => {
    const { store } = setup();
    expect(joinRoom(store, { socketId: 's', code: 'ZZZZZZ', name: 'X' }).code).toBe(
      ERROR_CODES.ROOM_NOT_FOUND,
    );
    expect(joinRoom(store, { socketId: 's', code: 'abc', name: 'X' }).code).toBe(
      ERROR_CODES.BAD_INPUT,
    );
    expect(joinRoom(store, { socketId: 's', code: 42, name: 'X' }).code).toBe(
      ERROR_CODES.BAD_INPUT,
    );
  });

  it('rejects invalid names', () => {
    const { join } = setup();
    expect(join('s1', '').code).toBe(ERROR_CODES.INVALID_NAME);
    expect(join('s2', '    ').code).toBe(ERROR_CODES.INVALID_NAME);
    expect(join('s3', 'x'.repeat(NAME_MAX_LENGTH + 1)).code).toBe(ERROR_CODES.INVALID_NAME);
    expect(join('s4', '<b></b>').code).toBe(ERROR_CODES.INVALID_NAME);
    expect(join('s5', null).code).toBe(ERROR_CODES.INVALID_NAME);
  });

  it('enforces maxPlayers', () => {
    const { join } = setup();
    for (let i = 0; i < LIMITS.maxPlayers; i += 1) expect(join(`s${i}`).ok).toBe(true);
    expect(join('extra').code).toBe(ERROR_CODES.ROOM_FULL);
  });

  it('rejects joins outside the lobby', () => {
    const { room, join } = setup();
    room.phase = 'playing';
    expect(join('s1').code).toBe(ERROR_CODES.GAME_IN_PROGRESS);
  });

  it('ignores a duplicate join from the same socket', () => {
    const { room, join } = setup();
    const first = join('s1', 'Ann');
    const second = join('s1', 'Ann');
    expect(second.ok).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(second.player).toBe(first.player);
    expect(room.players.size).toBe(1);
  });

  it('does not let the host socket join as a player', () => {
    const { join } = setup();
    expect(join('host').code).toBe(ERROR_CODES.BAD_INPUT);
  });
});

describe('name sanitizing', () => {
  it('trims, strips HTML and control chars, collapses spaces', () => {
    expect(sanitizeName('  Ann  ')).toBe('Ann');
    expect(sanitizeName('<script>alert(1)</script>Bob')).toBe('alert(1)Bob');
    expect(sanitizeName('<img src=x onerror=y>Cy')).toBe('Cy');
    expect(sanitizeName('a<b')).toBe('ab');
    expect(sanitizeName('Al\u0000\u200Bex')).toBe('Alex');
    expect(sanitizeName('Mary   Jo')).toBe('Mary Jo');
  });

  it('counts emoji as single characters', () => {
    expect(sanitizeName('🔥'.repeat(NAME_MAX_LENGTH))).toBe('🔥'.repeat(NAME_MAX_LENGTH));
    expect(sanitizeName('🔥'.repeat(NAME_MAX_LENGTH + 1))).toBeNull();
  });

  it('normalizes room codes', () => {
    expect(normalizeRoomCode(' abcdef ')).toBe('ABCDEF');
    expect(normalizeRoomCode('ABCDE0')).toBeNull(); // 0 is not in the alphabet
    expect(normalizeRoomCode(undefined)).toBeNull();
  });
});

describe('rejoin', () => {
  let ctx;
  let player;
  beforeEach(() => {
    ctx = setup();
    player = ctx.join('s1', 'Ann').player;
    disconnectSocket(ctx.store, 's1', 1000);
  });

  it('restores the same player with a valid token', () => {
    expect(player.connected).toBe(false);
    const r = rejoinRoom(ctx.store, {
      socketId: 's1b',
      code: ctx.room.code,
      playerId: player.id,
      reconnectToken: player.reconnectToken,
    });
    expect(r.ok).toBe(true);
    expect(r.player).toBe(player);
    expect(player.connected).toBe(true);
    expect(player.socketId).toBe('s1b');
    expect(player.colorIndex).toBe(0);
    expect(ctx.store.sockets.get('s1b')).toMatchObject({ role: 'player', playerId: player.id });
  });

  it('rejects a wrong token or unknown player', () => {
    const base = { socketId: 'x', code: ctx.room.code };
    expect(
      rejoinRoom(ctx.store, { ...base, playerId: player.id, reconnectToken: 'nope' }).code,
    ).toBe(ERROR_CODES.BAD_INPUT);
    expect(
      rejoinRoom(ctx.store, { ...base, playerId: 'ghost', reconnectToken: player.reconnectToken })
        .code,
    ).toBe(ERROR_CODES.BAD_INPUT);
    expect(
      rejoinRoom(ctx.store, {
        socketId: 'x',
        code: 'ZZZZZZ',
        playerId: player.id,
        reconnectToken: player.reconnectToken,
      }).code,
    ).toBe(ERROR_CODES.ROOM_NOT_FOUND);
    expect(player.connected).toBe(false);
  });

  it('takes over from a still-connected old socket', () => {
    rejoinRoom(ctx.store, {
      socketId: 'a',
      code: ctx.room.code,
      playerId: player.id,
      reconnectToken: player.reconnectToken,
    });
    const r = rejoinRoom(ctx.store, {
      socketId: 'b',
      code: ctx.room.code,
      playerId: player.id,
      reconnectToken: player.reconnectToken,
    });
    expect(r.previousSocketId).toBe('a');
    expect(ctx.store.sockets.has('a')).toBe(false);
    // The stale socket's late disconnect must not mark the player offline.
    expect(disconnectSocket(ctx.store, 'a')).toBeNull();
    expect(player.connected).toBe(true);
  });
});

describe('disconnects and grace period', () => {
  it('removes a lobby player only after the grace period', () => {
    const { store, room, join } = setup();
    const { player } = join('s1');
    expect(expirePlayer(room, player.id, 0)).toBe(false); // still connected
    disconnectSocket(store, 's1', 1000);
    expect(toSnapshot(room).players[0].connected).toBe(false);
    expect(expirePlayer(room, player.id, 1000 + RECONNECT_GRACE_MS - 1)).toBe(false);
    expect(expirePlayer(room, player.id, 1000 + RECONNECT_GRACE_MS)).toBe(true);
    expect(room.players.size).toBe(0);
  });

  it('does not remove a player who reconnected', () => {
    const { store, room, join } = setup();
    const { player } = join('s1');
    disconnectSocket(store, 's1', 0);
    rejoinRoom(store, {
      socketId: 's2',
      code: room.code,
      playerId: player.id,
      reconnectToken: player.reconnectToken,
    });
    expect(expirePlayer(room, player.id, RECONNECT_GRACE_MS * 2)).toBe(false);
    expect(room.players.size).toBe(1);
  });

  it('keeps disconnected players outside the lobby', () => {
    const { store, room, join } = setup();
    const { player } = join('s1');
    room.phase = 'playing';
    disconnectSocket(store, 's1', 0);
    expect(expirePlayer(room, player.id, RECONNECT_GRACE_MS * 2)).toBe(false);
  });

  it('counts only connected players toward canStart', () => {
    const { store, room, join } = setup();
    join('s1');
    join('s2');
    expect(canStart(room)).toBe(true);
    disconnectSocket(store, 's2', 0);
    expect(canStart(room)).toBe(false);
  });

  it('reuses the lowest free color after a player leaves', () => {
    const { store, room, join } = setup();
    const a = join('s1').player;
    join('s2');
    join('s3');
    disconnectSocket(store, 's1', 0);
    expirePlayer(room, a.id, RECONNECT_GRACE_MS);
    const d = join('s4').player;
    expect(d.colorIndex).toBe(0);
    expect(d.joinOrder).toBe(3);
  });

  it('frees a slot for a new joiner once the grace period removes someone', () => {
    const { store, room, join } = setup();
    const ids = [0, 1, 2, 3].map((i) => join(`s${i}`).player.id);
    expect(join('late').code).toBe(ERROR_CODES.ROOM_FULL);
    disconnectSocket(store, 's2', 0);
    expect(join('late').code).toBe(ERROR_CODES.ROOM_FULL); // still holding the seat
    expirePlayer(room, ids[2], RECONNECT_GRACE_MS);
    expect(join('late').player.colorIndex).toBe(2);
  });

  it('tracks host disconnect, reclaim and expiry', () => {
    const { store, room } = setup();
    expect(disconnectSocket(store, 'host', 0)).toMatchObject({ role: 'host' });
    expect(isHostExpired(room, RECONNECT_GRACE_MS - 1)).toBe(false);
    expect(isHostExpired(room, RECONNECT_GRACE_MS)).toBe(true);

    expect(reclaimHost(store, { socketId: 'h2', code: room.code, hostToken: 'bad' }).code).toBe(
      ERROR_CODES.NOT_HOST,
    );
    expect(
      reclaimHost(store, { socketId: 'h2', code: room.code, hostToken: room.hostToken }).ok,
    ).toBe(true);
    expect(isHostExpired(room, RECONNECT_GRACE_MS * 2)).toBe(false);
    expect(room.hostSocketId).toBe('h2');
  });

  it('deleteRoom removes all socket bindings', () => {
    const { store, room, join } = setup();
    join('s1');
    expect(deleteRoom(store, room.code)).toBe(room);
    expect(store.rooms.size).toBe(0);
    expect(store.sockets.size).toBe(0);
    expect(deleteRoom(store, room.code)).toBeNull();
  });
});

describe('startGame', () => {
  it('rejects non-hosts with NOT_HOST', () => {
    const { store, join } = setup();
    join('s1');
    join('s2');
    expect(startGame(store, 's1')).toMatchObject({ ok: false, code: ERROR_CODES.NOT_HOST });
    expect(startGame(store, 'stranger')).toMatchObject({ ok: false, code: ERROR_CODES.NOT_HOST });
  });

  it('rejects with NOT_ENOUGH_PLAYERS, counting only connected players', () => {
    const { store, room, join } = setup();
    join('s1');
    expect(startGame(store, 'host')).toMatchObject({
      ok: false,
      code: ERROR_CODES.NOT_ENOUGH_PLAYERS,
    });
    join('s2');
    disconnectSocket(store, 's2');
    expect(startGame(store, 'host').code).toBe(ERROR_CODES.NOT_ENOUGH_PLAYERS);
    expect(room.phase).toBe('lobby');
  });

  it('starts from the lobby once, then rejects with GAME_IN_PROGRESS', () => {
    const { store, room, join } = setup();
    join('s1');
    join('s2');
    expect(startGame(store, 'host')).toEqual({ ok: true, room });
    expect(room.phase).toBe('playing');
    expect(room.round).toBe(1);
    expect(startGame(store, 'host')).toMatchObject({
      ok: false,
      code: ERROR_CODES.GAME_IN_PROGRESS,
    });
    expect(room.round).toBe(1);
  });

  it('rejects a stale host socket after the host reclaimed the room', () => {
    const { store, room, join } = setup({ minPlayers: 1, maxPlayers: 4 });
    join('s1');
    reclaimHost(store, { socketId: 'host2', code: room.code, hostToken: room.hostToken });
    expect(startGame(store, 'host').code).toBe(ERROR_CODES.NOT_HOST);
    expect(startGame(store, 'host2').ok).toBe(true);
  });
});
