// Pure room/lobby logic. No sockets and no timers: index.js owns those and calls in here.
// Every mutating function returns either { ok: true, ... } or an ackError() result so the
// socket layer can forward it straight to the client's ack.

import { randomInt, randomUUID } from 'node:crypto';
import { ERROR_CODES, ackError } from '@rumble/shared/protocol';
import {
  NAME_MAX_LENGTH,
  PLAYER_COLORS,
  RECONNECT_GRACE_MS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from '@rumble/shared/constants';

const ROOM_CODE_PATTERN = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);
const MAX_CODE_ATTEMPTS = 1000;

/**
 * @typedef {object} Player
 * @property {string} id
 * @property {string} reconnectToken
 * @property {string} name
 * @property {number} colorIndex
 * @property {number} joinOrder
 * @property {string|null} socketId
 * @property {boolean} connected
 * @property {number|null} disconnectedAt
 * @property {number} roundWins
 * @property {number} knockouts
 * @property {number} survivalMs
 */

/**
 * @typedef {object} Room
 * @property {string} code
 * @property {string|null} hostSocketId
 * @property {string} hostToken
 * @property {number|null} hostDisconnectedAt
 * @property {import('@rumble/shared/protocol').RoomPhase} phase
 * @property {Map<string, Player>} players   Keyed by playerId.
 * @property {number} nextJoinOrder
 * @property {number} round
 * @property {number} minPlayers
 * @property {number} maxPlayers
 * @property {number} createdAt
 * @property {import('./gameLoop.js').GameState|null} game  Simulation state while playing.
 * @property {{ handle: unknown, clear: () => void }|null} loop  Running tick loop (gameLoop.js).
 */

/**
 * @typedef {object} RoomStore
 * @property {Map<string, Room>} rooms                                  Keyed by room code.
 * @property {Map<string, { code: string, role: 'host'|'player', playerId?: string }>} sockets
 */

/** @returns {RoomStore} */
export function createRoomStore() {
  return { rooms: new Map(), sockets: new Map() };
}

/**
 * @param {() => number} [pick] returns an index into ROOM_CODE_ALPHABET
 */
export function generateRoomCode(pick = () => randomInt(ROOM_CODE_ALPHABET.length)) {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) code += ROOM_CODE_ALPHABET[pick()];
  return code;
}

/**
 * Normalize user-typed room code input. Returns null when it can't be a valid code.
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeRoomCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return ROOM_CODE_PATTERN.test(code) ? code : null;
}

/**
 * Trim, strip HTML tags / angle brackets / control characters and collapse whitespace.
 * Returns null unless the result is 1..NAME_MAX_LENGTH characters (code points).
 * @param {unknown} value
 * @returns {string|null}
 */
export function sanitizeName(value) {
  if (typeof value !== 'string') return null;
  const name = value
    .replace(/<[^>]*>/g, '')
    .replace(/[<>]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const length = Array.from(name).length;
  return length >= 1 && length <= NAME_MAX_LENGTH ? name : null;
}

/** @param {Room} room */
export function connectedPlayerCount(room) {
  let count = 0;
  for (const p of room.players.values()) if (p.connected) count += 1;
  return count;
}

/** @param {Room} room */
export function canStart(room) {
  return (
    (room.phase === 'lobby' || room.phase === 'results') &&
    connectedPlayerCount(room) >= room.minPlayers
  );
}

/**
 * Public view of a room, safe to broadcast (no tokens, no socket ids).
 * @param {Room} room
 * @returns {import('@rumble/shared/protocol').RoomSnapshot}
 */
export function toSnapshot(room) {
  const players = [...room.players.values()]
    .sort((a, b) => a.joinOrder - b.joinOrder)
    .map((p) => ({
      id: p.id,
      name: p.name,
      colorIndex: p.colorIndex,
      joinOrder: p.joinOrder,
      connected: p.connected,
      roundWins: p.roundWins,
      knockouts: p.knockouts,
      survivalMs: p.survivalMs,
    }));
  return {
    code: room.code,
    phase: room.phase,
    players,
    minPlayers: room.minPlayers,
    maxPlayers: room.maxPlayers,
    round: room.round,
    canStart: canStart(room),
  };
}

/** Lowest colorIndex not used by any player still in the room. */
function lowestFreeColor(room) {
  const used = new Set([...room.players.values()].map((p) => p.colorIndex));
  for (let i = 0; i < PLAYER_COLORS.length; i += 1) if (!used.has(i)) return i;
  return -1;
}

/**
 * Create a room hosted by `socketId`. If that socket already hosts a room, the existing room
 * is returned (idempotent, e.g. React StrictMode double effects).
 * @param {RoomStore} store
 * @param {{ socketId: string, limits: { minPlayers: number, maxPlayers: number },
 *           now?: number, pick?: () => number }} options
 */
export function createRoom(store, { socketId, limits, now = Date.now(), pick }) {
  const existing = store.sockets.get(socketId);
  if (existing?.role === 'host' && store.rooms.has(existing.code)) {
    return { ok: true, room: store.rooms.get(existing.code), created: false };
  }
  if (existing) {
    return ackError(ERROR_CODES.BAD_INPUT, 'This connection is already a player in a room.');
  }

  let code = null;
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const candidate = generateRoomCode(pick);
    if (!store.rooms.has(candidate)) {
      code = candidate;
      break;
    }
  }
  if (!code) return ackError(ERROR_CODES.BAD_INPUT, 'Could not allocate a room code.');

  /** @type {Room} */
  const room = {
    code,
    hostSocketId: socketId,
    hostToken: randomUUID(),
    hostDisconnectedAt: null,
    phase: 'lobby',
    players: new Map(),
    nextJoinOrder: 0,
    round: 0,
    minPlayers: limits.minPlayers,
    maxPlayers: limits.maxPlayers,
    createdAt: now,
    game: null,
    loop: null,
  };
  store.rooms.set(code, room);
  store.sockets.set(socketId, { code, role: 'host' });
  return { ok: true, room, created: true };
}

/**
 * Re-attach a host socket to its room after a reload/reconnect (within the grace period).
 * @param {RoomStore} store
 * @param {{ socketId: string, code: unknown, hostToken: unknown }} options
 */
export function reclaimHost(store, { socketId, code, hostToken }) {
  const normalized = normalizeRoomCode(code);
  const room = normalized ? store.rooms.get(normalized) : undefined;
  if (!room) return ackError(ERROR_CODES.ROOM_NOT_FOUND, 'That room no longer exists.');
  if (typeof hostToken !== 'string' || hostToken !== room.hostToken) {
    return ackError(ERROR_CODES.NOT_HOST, 'You are not the host of this room.');
  }
  if (store.sockets.has(socketId) && store.sockets.get(socketId).code !== room.code) {
    return ackError(ERROR_CODES.BAD_INPUT, 'This connection already belongs to another room.');
  }
  const previousSocketId = room.hostSocketId;
  if (previousSocketId && previousSocketId !== socketId) store.sockets.delete(previousSocketId);
  room.hostSocketId = socketId;
  room.hostDisconnectedAt = null;
  store.sockets.set(socketId, { code: room.code, role: 'host' });
  return { ok: true, room, previousSocketId };
}

/**
 * Join a lobby as a new player.
 * @param {RoomStore} store
 * @param {{ socketId: string, code: unknown, name: unknown }} options
 */
export function joinRoom(store, { socketId, code, name }) {
  const normalized = normalizeRoomCode(code);
  if (!normalized) return ackError(ERROR_CODES.BAD_INPUT, 'Room codes are 6 letters/numbers.');
  const room = store.rooms.get(normalized);
  if (!room) return ackError(ERROR_CODES.ROOM_NOT_FOUND, `Room ${normalized} not found.`);

  const binding = store.sockets.get(socketId);
  if (binding) {
    // Duplicate join from the same socket: hand back the existing player, don't add another.
    if (binding.role === 'player' && binding.code === room.code) {
      const player = room.players.get(binding.playerId);
      if (player) return { ok: true, room, player, duplicate: true };
    }
    return ackError(ERROR_CODES.BAD_INPUT, 'This connection is already in a room.');
  }

  const cleanName = sanitizeName(name);
  if (!cleanName) {
    return ackError(ERROR_CODES.INVALID_NAME, `Name must be 1-${NAME_MAX_LENGTH} characters.`);
  }
  if (room.phase !== 'lobby') {
    return ackError(ERROR_CODES.GAME_IN_PROGRESS, 'A game is already in progress.');
  }
  if (room.players.size >= room.maxPlayers) {
    return ackError(ERROR_CODES.ROOM_FULL, `Room is full (${room.maxPlayers} players).`);
  }
  const colorIndex = lowestFreeColor(room);
  if (colorIndex < 0) return ackError(ERROR_CODES.ROOM_FULL, 'Room is full.');

  /** @type {Player} */
  const player = {
    id: randomUUID(),
    reconnectToken: randomUUID(),
    name: cleanName,
    colorIndex,
    joinOrder: room.nextJoinOrder,
    socketId,
    connected: true,
    disconnectedAt: null,
    roundWins: 0,
    knockouts: 0,
    survivalMs: 0,
  };
  room.nextJoinOrder += 1;
  room.players.set(player.id, player);
  store.sockets.set(socketId, { code: room.code, role: 'player', playerId: player.id });
  return { ok: true, room, player, duplicate: false };
}

/**
 * Validate and apply game:start from `socketId`: host only, from the lobby, with enough
 * connected players. On success the room moves to 'playing' and the round counter advances;
 * the caller creates the game state and starts the loop.
 * @param {RoomStore} store
 * @param {string} socketId
 */
export function startGame(store, socketId) {
  const binding = store.sockets.get(socketId);
  if (binding?.role !== 'host') {
    return ackError(ERROR_CODES.NOT_HOST, 'Only the host can start the game.');
  }
  const room = store.rooms.get(binding.code);
  if (!room) return ackError(ERROR_CODES.ROOM_NOT_FOUND, 'That room no longer exists.');
  if (room.hostSocketId !== socketId) {
    return ackError(ERROR_CODES.NOT_HOST, 'Only the host can start the game.');
  }
  if (room.phase !== 'lobby') {
    return ackError(ERROR_CODES.GAME_IN_PROGRESS, 'A game is already in progress.');
  }
  const connected = connectedPlayerCount(room);
  if (connected < room.minPlayers) {
    return ackError(
      ERROR_CODES.NOT_ENOUGH_PLAYERS,
      `Need at least ${room.minPlayers} connected players (have ${connected}).`,
    );
  }
  room.phase = 'playing';
  room.round += 1;
  return { ok: true, room };
}

/**
 * Reclaim an existing player slot from a new socket.
 * @param {RoomStore} store
 * @param {{ socketId: string, code: unknown, playerId: unknown, reconnectToken: unknown }} options
 */
export function rejoinRoom(store, { socketId, code, playerId, reconnectToken }) {
  const normalized = normalizeRoomCode(code);
  if (!normalized) return ackError(ERROR_CODES.BAD_INPUT, 'Room codes are 6 letters/numbers.');
  const room = store.rooms.get(normalized);
  if (!room) return ackError(ERROR_CODES.ROOM_NOT_FOUND, `Room ${normalized} not found.`);

  const player = typeof playerId === 'string' ? room.players.get(playerId) : undefined;
  if (!player || typeof reconnectToken !== 'string' || player.reconnectToken !== reconnectToken) {
    return ackError(ERROR_CODES.BAD_INPUT, 'Your seat in this room has expired.');
  }

  const binding = store.sockets.get(socketId);
  if (binding && !(binding.role === 'player' && binding.playerId === player.id)) {
    return ackError(ERROR_CODES.BAD_INPUT, 'This connection is already in a room.');
  }

  const previousSocketId = player.socketId;
  if (previousSocketId && previousSocketId !== socketId) store.sockets.delete(previousSocketId);
  player.socketId = socketId;
  player.connected = true;
  player.disconnectedAt = null;
  store.sockets.set(socketId, { code: room.code, role: 'player', playerId: player.id });
  return { ok: true, room, player, previousSocketId };
}

/**
 * Handle a socket going away. Marks the host or player as disconnected (grace period starts).
 * @param {RoomStore} store
 * @param {string} socketId
 * @param {number} [now]
 * @returns {null | { room: Room, role: 'host' } | { room: Room, role: 'player', player: Player }}
 */
export function disconnectSocket(store, socketId, now = Date.now()) {
  const binding = store.sockets.get(socketId);
  store.sockets.delete(socketId);
  if (!binding) return null;
  const room = store.rooms.get(binding.code);
  if (!room) return null;

  if (binding.role === 'host') {
    if (room.hostSocketId !== socketId) return null;
    room.hostSocketId = null;
    room.hostDisconnectedAt = now;
    return { room, role: 'host' };
  }

  const player = room.players.get(binding.playerId);
  if (!player || player.socketId !== socketId) return null;
  player.socketId = null;
  player.connected = false;
  player.disconnectedAt = now;
  return { room, role: 'player', player };
}

/**
 * Remove a player whose grace period ran out. Only applies in the lobby; during a match the
 * game loop treats them as eliminated instead. Returns true if the player was removed.
 * @param {Room} room
 * @param {string} playerId
 * @param {number} [now]
 * @param {number} [graceMs]
 */
export function expirePlayer(room, playerId, now = Date.now(), graceMs = RECONNECT_GRACE_MS) {
  const player = room.players.get(playerId);
  if (!player || player.connected || player.disconnectedAt == null) return false;
  if (room.phase !== 'lobby') return false;
  if (now - player.disconnectedAt < graceMs) return false;
  room.players.delete(playerId);
  return true;
}

/**
 * True if the host has been gone for at least the grace period.
 * @param {Room} room
 * @param {number} [now]
 * @param {number} [graceMs]
 */
export function isHostExpired(room, now = Date.now(), graceMs = RECONNECT_GRACE_MS) {
  return (
    room.hostSocketId == null &&
    room.hostDisconnectedAt != null &&
    now - room.hostDisconnectedAt >= graceMs
  );
}

/**
 * Delete a room and every socket binding pointing at it.
 * @param {RoomStore} store
 * @param {string} code
 * @returns {Room|null} the removed room
 */
export function deleteRoom(store, code) {
  const room = store.rooms.get(code);
  if (!room) return null;
  store.rooms.delete(code);
  for (const [socketId, binding] of store.sockets) {
    if (binding.code === code) store.sockets.delete(socketId);
  }
  return room;
}
