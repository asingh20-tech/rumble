import { describe, it, expect } from 'vitest';
import { EVENTS, ERROR_CODES, ackOk, ackError } from '@rumble/shared/protocol';
import {
  ARENA,
  PLAYER_COLORS,
  TICK_RATE,
  resolvePlayerLimits,
} from '@rumble/shared/constants';

describe('shared contract (server)', () => {
  it('imports protocol events and error codes', () => {
    expect(EVENTS.ROOM_JOIN).toBe('room:join');
    expect(EVENTS.GAME_STATE).toBe('game:state');
    expect(Object.values(EVENTS)).toHaveLength(14);
    expect(new Set(Object.values(EVENTS)).size).toBe(14);
    expect(Object.keys(ERROR_CODES)).toEqual([
      'ROOM_NOT_FOUND',
      'ROOM_FULL',
      'GAME_IN_PROGRESS',
      'INVALID_NAME',
      'NOT_HOST',
      'NOT_ENOUGH_PLAYERS',
      'RATE_LIMITED',
      'BAD_INPUT',
    ]);
  });

  it('builds ack results', () => {
    expect(ackOk({ playerId: 'p1' })).toEqual({ ok: true, playerId: 'p1' });
    expect(ackOk()).toEqual({ ok: true });
    expect(ackError(ERROR_CODES.ROOM_FULL, 'Room is full')).toEqual({
      ok: false,
      code: 'ROOM_FULL',
      message: 'Room is full',
    });
  });

  it('imports constants', () => {
    expect(TICK_RATE).toBe(30);
    expect(ARENA).toMatchObject({ width: 960, height: 600, centerX: 480, centerY: 300 });
    expect(PLAYER_COLORS).toHaveLength(8);
  });

  it('resolves player limits from env', () => {
    expect(resolvePlayerLimits({})).toEqual({ minPlayers: 4, maxPlayers: 8, isDev: false });
    expect(resolvePlayerLimits({ NODE_ENV: 'development' }).minPlayers).toBe(1);
    expect(resolvePlayerLimits({ MIN_PLAYERS: '2', MAX_PLAYERS: '6' })).toMatchObject({
      minPlayers: 2,
      maxPlayers: 6,
    });
    expect(resolvePlayerLimits({ MAX_PLAYERS: '99' }).maxPlayers).toBe(8);
    expect(resolvePlayerLimits({ MIN_PLAYERS: 'abc' }).minPlayers).toBe(4);
  });
});
