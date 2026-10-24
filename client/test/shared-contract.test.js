import { describe, it, expect } from 'vitest';
import { EVENTS, ERROR_CODES, ackError } from '@rumble/shared/protocol';
import { PLAYER_COLORS, SHAKES_TO_CHARGE } from '@rumble/shared/constants';

describe('shared contract (client)', () => {
  it('imports protocol through the client toolchain', () => {
    expect(EVENTS.PLAYER_INPUT).toBe('player:input');
    expect(EVENTS.ERROR).toBe('error');
    expect(Object.values(EVENTS)).toHaveLength(14);
    expect(ERROR_CODES.NOT_ENOUGH_PLAYERS).toBe('NOT_ENOUGH_PLAYERS');
    expect(ackError(ERROR_CODES.BAD_INPUT, 'x').ok).toBe(false);
  });

  it('imports constants through the client toolchain', () => {
    expect(SHAKES_TO_CHARGE).toBe(3);
    expect(PLAYER_COLORS.map((c) => c.hex)).toContain('#22D3EE');
  });
});
