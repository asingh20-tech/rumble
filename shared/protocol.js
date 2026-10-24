// Socket.IO contract between host laptop, phone controllers and server.
//
// Conventions
// - "C→S" = client to server, "S→C" = server to client(s).
// - Events that take an acknowledgement call `ack(result)` exactly once with an AckResult.
// - Phones only ever send inputs. Positions, charge, scores and winners are server-owned.
// - The server validates every payload; malformed payloads are rejected with BAD_INPUT
//   (or silently dropped for high-frequency events without an ack).

/**
 * @typedef {'ROOM_NOT_FOUND'|'ROOM_FULL'|'GAME_IN_PROGRESS'|'INVALID_NAME'|'NOT_HOST'|'NOT_ENOUGH_PLAYERS'|'RATE_LIMITED'|'BAD_INPUT'} ErrorCode
 */

/**
 * @template T
 * @typedef {({ ok: true } & T) | { ok: false, code: ErrorCode, message: string }} AckResult
 */

/**
 * @typedef {'lobby'|'countdown'|'playing'|'results'} RoomPhase
 */

/**
 * @typedef {object} PlayerSummary
 * @property {string} id           Server-issued playerId.
 * @property {string} name         Display name, 1..NAME_MAX_LENGTH chars, trimmed.
 * @property {number} colorIndex   Index into PLAYER_COLORS.
 * @property {number} joinOrder    Monotonic join counter (tie-breaker).
 * @property {boolean} connected   False while inside the reconnect grace period.
 * @property {number} roundWins
 * @property {number} knockouts
 * @property {number} survivalMs   Total survival time across rounds.
 */

/**
 * @typedef {object} RoomSnapshot
 * @property {string} code
 * @property {RoomPhase} phase
 * @property {PlayerSummary[]} players   Sorted by joinOrder.
 * @property {number} minPlayers
 * @property {number} maxPlayers
 * @property {number} round             Number of rounds started so far (0 in a fresh lobby).
 * @property {boolean} canStart         True when the host may start/rematch now (enough
 *                                      connected players and phase is 'lobby' or 'results').
 */

/**
 * @typedef {object} PlayerState
 * @property {string} id
 * @property {number} x            World units, 0..ARENA.width.
 * @property {number} y            World units, 0..ARENA.height.
 * @property {number} vx
 * @property {number} vy
 * @property {number} charge       0..SHAKES_TO_CHARGE.
 * @property {boolean} alive
 * @property {boolean} connected
 */

/**
 * @typedef {object} GameEvent
 * @property {number} id           Unique per room and strictly increasing, so clients can play
 *                                 each effect exactly once even if a snapshot is re-received.
 * @property {'shockwave'|'eliminated'} type
 * @property {string} playerId     'shockwave': the attacker. 'eliminated': the player knocked out.
 * @property {string|null} [byId]  'eliminated' only: credited knocker (null if self-out / disconnect).
 * @property {number} x            World position where the effect happens.
 * @property {number} y
 */

/**
 * @typedef {object} Standing
 * @property {string} id
 * @property {string} name
 * @property {number} colorIndex
 * @property {number} knockouts
 * @property {number} survivalMs
 * @property {number} roundWins
 */

export const EVENTS = Object.freeze({
  /**
   * C→S (host laptop). Create a new room; the creating socket becomes host.
   * payload: {} to create, or { code: string, hostToken: string } to reclaim a room after a
   *          reload/reconnect (within RECONNECT_GRACE_MS). If the code/token is invalid or the
   *          room is gone, a new room is created instead.
   * ack: AckResult<{ room: RoomSnapshot, hostToken: string }>
   */
  ROOM_CREATE: 'room:create',

  /**
   * C→S (phone). Join a lobby.
   * payload: { code: string, name: string }  code: ROOM_CODE_LENGTH chars from
   *          ROOM_CODE_ALPHABET (case-insensitive on input); name: 1..NAME_MAX_LENGTH chars.
   * ack: AckResult<{ playerId: string, reconnectToken: string, room: RoomSnapshot }>
   * errors: ROOM_NOT_FOUND, ROOM_FULL, GAME_IN_PROGRESS, INVALID_NAME, BAD_INPUT
   */
  ROOM_JOIN: 'room:join',

  /**
   * C→S (phone). Reclaim a player slot after reload/disconnect (within RECONNECT_GRACE_MS,
   * or any time while the room still holds the player).
   * payload: { code: string, playerId: string, reconnectToken: string }
   * ack: AckResult<{ playerId: string, room: RoomSnapshot }>
   * errors: ROOM_NOT_FOUND, BAD_INPUT (unknown player or wrong token)
   */
  ROOM_REJOIN: 'room:rejoin',

  /**
   * S→C (whole room). Sent whenever lobby membership, phase or scores change.
   * payload: RoomSnapshot
   */
  ROOM_UPDATE: 'room:update',

  /**
   * S→C (whole room). The room no longer exists; clients should return to home/join.
   * payload: { code: string, reason: 'host_left' | 'expired' }
   */
  ROOM_CLOSED: 'room:closed',

  /**
   * C→S (phone). Continuous tilt input, sent at most INPUT_RATE_LIMIT_PER_SEC times per
   * second. Excess messages are dropped silently. Out-of-range values are rejected.
   * payload: { x: number, y: number, seq: number }  x,y in [-1, 1] (right/down positive);
   *          seq is a non-negative integer, increasing per socket.
   * ack: none
   */
  PLAYER_INPUT: 'player:input',

  /**
   * C→S (phone). One detected shake. Deduplicated server-side: a seq not greater than the
   * last accepted seq is ignored, and a minimum interval applies between accepted shakes.
   * payload: { seq: number }  non-negative integer, increasing per client session.
   * ack (optional): AckResult<{ charge: number, accepted: boolean }>
   * errors: RATE_LIMITED, BAD_INPUT
   */
  PLAYER_SHAKE: 'player:shake',

  /**
   * C→S (phone). Release the shockwave. Only valid when charge === SHAKES_TO_CHARGE;
   * a successful attack resets charge to 0.
   * payload: {}
   * ack (optional): AckResult<{}>
   * errors: BAD_INPUT (not charged / not alive / not playing), RATE_LIMITED
   */
  PLAYER_ATTACK: 'player:attack',

  /**
   * C→S (host). Start the first round from the lobby.
   * payload: {}
   * ack: AckResult<{}>
   * errors: ROOM_NOT_FOUND, NOT_HOST, NOT_ENOUGH_PLAYERS, GAME_IN_PROGRESS
   */
  GAME_START: 'game:start',

  /**
   * S→C (whole room). Countdown ticks: COUNTDOWN_SECONDS, ..., 1, then 0 = GO.
   * payload: { secondsLeft: number, round: number }
   */
  GAME_COUNTDOWN: 'game:countdown',

  /**
   * S→C (whole room). Authoritative snapshot, TICK_RATE times per second while playing.
   * payload: { tick: number, serverTime: number, timeLeftMs: number,
   *            players: PlayerState[], events: GameEvent[] }
   */
  GAME_STATE: 'game:state',

  /**
   * S→C (whole room). Round finished; room phase becomes 'results'.
   * payload: { winnerId: string | null, reason: 'last-standing' | 'timeout', round: number,
   *            standings: Standing[] }
   * winnerId is null only if no player is left to win (e.g. everyone disconnected).
   * standings are sorted by the winner rules: index 0 is the winner, then survivors nearest
   * the center, then eliminated players (latest elimination first); ties broken by most
   * knockouts, then earliest join order. knockouts and survivalMs are for this round;
   * roundWins is the room total including this round.
   */
  GAME_OVER: 'game:over',

  /**
   * C→S (host). Start another round with the current players (scores persist).
   * payload: {}
   * ack: AckResult<{}>
   * errors: ROOM_NOT_FOUND, NOT_HOST, NOT_ENOUGH_PLAYERS, GAME_IN_PROGRESS
   */
  GAME_REMATCH: 'game:rematch',

  /**
   * S→C (single socket). Unsolicited error not tied to an ack (e.g. RATE_LIMITED).
   * Server→client only: the server ignores inbound 'error' events.
   * payload: { code: ErrorCode, message: string }
   */
  ERROR: 'error',
});

export const ERROR_CODES = Object.freeze({
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  GAME_IN_PROGRESS: 'GAME_IN_PROGRESS',
  INVALID_NAME: 'INVALID_NAME',
  NOT_HOST: 'NOT_HOST',
  NOT_ENOUGH_PLAYERS: 'NOT_ENOUGH_PLAYERS',
  RATE_LIMITED: 'RATE_LIMITED',
  BAD_INPUT: 'BAD_INPUT',
});

/**
 * Build a successful ack result.
 * @template {object} T
 * @param {T} [data]
 * @returns {{ ok: true } & T}
 */
export function ackOk(data) {
  return { ok: true, ...(data ?? {}) };
}

/**
 * Build a failed ack result.
 * @param {ErrorCode} code
 * @param {string} message
 * @returns {{ ok: false, code: ErrorCode, message: string }}
 */
export function ackError(code, message) {
  return { ok: false, code, message };
}
