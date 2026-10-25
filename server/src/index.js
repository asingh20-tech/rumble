import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import {
  INPUT_RATE_LIMIT_PER_SEC,
  RECONNECT_GRACE_MS,
  resolvePlayerLimits,
} from '@rumble/shared/constants';
import { EVENTS, ERROR_CODES, ackError, ackOk } from '@rumble/shared/protocol';
import {
  createRoom,
  createRoomStore,
  deleteRoom,
  disconnectSocket,
  expirePlayer,
  isHostExpired,
  joinRoom,
  reclaimHost,
  rejoinRoom,
  startGame,
  toSnapshot,
} from './rooms.js';
import {
  SHAKE_RATE_LIMIT_PER_SEC,
  applyInput,
  applyShake,
  countDropped,
  createInputStore,
  createRateLimiter,
  parseInput,
  parseShake,
  readInput,
  removeInputState,
  resetCharge,
  startInputSession,
  takeInputSummary,
} from './input.js';
import {
  buildStatePayload,
  createGameState,
  startGameLoop,
  stepGame,
  stopGameLoop,
} from './gameLoop.js';

const DEFAULT_CLIENT_ORIGIN = 'http://localhost:5173';

/**
 * Parse CLIENT_ORIGIN (comma-separated list) into an array of allowed origins.
 * @param {string | undefined} value
 * @returns {string[]}
 */
export function parseOrigins(value) {
  const origins = (value ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return origins.length > 0 ? origins : [DEFAULT_CLIENT_ORIGIN];
}

/**
 * Build the HTTP + Socket.IO server without listening, so tests can bind an ephemeral port.
 * @param {{ env?: Record<string, string | undefined> }} [options]
 */
export function createRumbleServer({ env = process.env } = {}) {
  const origins = parseOrigins(env.CLIENT_ORIGIN);
  const limits = resolvePlayerLimits(env);

  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: origins }));
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  const httpServer = createServer(app);
  const io = new Server(httpServer, { cors: { origin: origins } });

  const graceMs = Number.parseInt(env.RECONNECT_GRACE_MS ?? '', 10) || RECONNECT_GRACE_MS;
  const lobby = createLobbyHandlers(io, { limits, graceMs });
  io.on('connection', (socket) => {
    console.log(`[socket ${socket.id}] connected`);
    lobby.attach(socket);
  });
  // Clear pending grace timers when the server shuts down (tests, SIGTERM).
  const closeIo = io.close.bind(io);
  io.close = (fn) => {
    lobby.dispose();
    return closeIo(fn);
  };

  return { app, httpServer, io, origins, limits, store: lobby.store, inputs: lobby.inputs };
}

const log = (code, message) => console.log(`[room ${code}] ${message}`);

/** Call a client ack if one was provided; clients may omit it. */
function reply(ack, result) {
  if (typeof ack === 'function') ack(result);
}

/** Payloads must be plain objects; anything else is treated as empty/invalid. */
function asObject(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
}

/**
 * Socket wiring for room:create / join / rejoin, controller input and disconnect grace
 * periods. Room state lives in rooms.js and input state in input.js; this layer owns
 * Socket.IO rooms, broadcasts and timers.
 * @param {import('socket.io').Server} io
 * @param {{ limits: { minPlayers: number, maxPlayers: number, isDev?: boolean },
 *           graceMs: number, logInputs?: boolean }} options
 */
export function createLobbyHandlers(io, { limits, graceMs, logInputs = limits.isDev }) {
  const store = createRoomStore();
  const inputs = createInputStore();
  /** @type {Map<string, { input: ReturnType<typeof createRateLimiter>,
   *                       shake: ReturnType<typeof createRateLimiter> }>} socketId -> limiters */
  const limiters = new Map();
  /** @type {Map<string, NodeJS.Timeout>} playerId -> removal timer */
  const playerTimers = new Map();
  /** @type {Map<string, NodeJS.Timeout>} room code -> host-gone timer */
  const hostTimers = new Map();

  const broadcast = (room) => io.to(room.code).emit(EVENTS.ROOM_UPDATE, toSnapshot(room));

  const clearPlayerTimer = (playerId) => {
    clearTimeout(playerTimers.get(playerId));
    playerTimers.delete(playerId);
  };
  const clearHostTimer = (code) => {
    clearTimeout(hostTimers.get(code));
    hostTimers.delete(code);
  };

  const leaveSocketIoRoom = (socketId, code) => {
    if (socketId) io.sockets.sockets.get(socketId)?.leave(code);
  };

  const closeRoom = (code, reason) => {
    const room = deleteRoom(store, code);
    if (!room) return;
    if (stopGameLoop(room)) log(code, 'game loop stopped');
    room.game = null;
    clearHostTimer(code);
    for (const playerId of room.players.keys()) {
      clearPlayerTimer(playerId);
      removeInputState(inputs, playerId);
    }
    io.to(code).emit(EVENTS.ROOM_CLOSED, { code, reason });
    io.in(code).socketsLeave(code);
    log(code, `closed (${reason})`);
  };

  const emitState = (room) => {
    io.to(room.code).emit(
      EVENTS.GAME_STATE,
      buildStatePayload(room.game, room, { getCharge: (id) => inputs.get(id)?.charge ?? 0 }),
    );
  };

  /** Spawn bodies and (re)start the room's single tick loop. */
  const beginRound = (room) => {
    for (const playerId of room.players.keys()) resetCharge(inputs, playerId);
    room.game = createGameState(room);
    startGameLoop(room, {
      step: (dt) => stepGame(room.game, room, (id) => readInput(inputs, id), dt),
      afterSteps: () => emitState(room),
    });
    emitState(room);
    log(room.code, `round ${room.round} started with ${room.game.bodies.length} players`);
  };

  const getLimiters = (socketId) => {
    let entry = limiters.get(socketId);
    if (!entry) {
      entry = {
        input: createRateLimiter({ limit: INPUT_RATE_LIMIT_PER_SEC }),
        shake: createRateLimiter({ limit: SHAKE_RATE_LIMIT_PER_SEC }),
      };
      limiters.set(socketId, entry);
    }
    return entry;
  };

  const playerIdFor = (socketId) => {
    const binding = store.sockets.get(socketId);
    return binding?.role === 'player' ? binding.playerId : null;
  };

  // Development aid: one line per active player per second showing what the server receives.
  const inputLogTimer = logInputs
    ? setInterval(() => {
        const now = Date.now();
        for (const room of store.rooms.values()) {
          for (const player of room.players.values()) {
            const state = inputs.get(player.id);
            const line = state && takeInputSummary(state, player.name, now);
            if (line) log(room.code, line);
          }
        }
      }, 1000)
    : null;
  inputLogTimer?.unref();

  function attach(socket) {
    socket.on(EVENTS.ROOM_CREATE, (payload, ack) => {
      if (typeof payload === 'function') [payload, ack] = [{}, payload];
      const data = asObject(payload) ?? {};

      // Optional host reclaim after reload: { code, hostToken } from a previous create ack.
      if (data.code !== undefined || data.hostToken !== undefined) {
        const result = reclaimHost(store, { socketId: socket.id, ...data });
        if (result.ok) {
          const { room, previousSocketId } = result;
          if (previousSocketId && previousSocketId !== socket.id) {
            leaveSocketIoRoom(previousSocketId, room.code);
          }
          clearHostTimer(room.code);
          socket.join(room.code);
          log(room.code, `host reconnected (${socket.id})`);
          reply(ack, ackOk({ room: toSnapshot(room), hostToken: room.hostToken }));
          broadcast(room);
          return;
        }
        console.log(`[socket ${socket.id}] host reclaim failed: ${result.code}, creating new room`);
      }

      const result = createRoom(store, { socketId: socket.id, limits });
      if (!result.ok) return reply(ack, result);
      const { room, created } = result;
      socket.join(room.code);
      if (created) log(room.code, `created by host ${socket.id}`);
      reply(ack, ackOk({ room: toSnapshot(room), hostToken: room.hostToken }));
    });

    socket.on(EVENTS.ROOM_JOIN, (payload, ack) => {
      const data = asObject(payload);
      if (!data) return reply(ack, ackError(ERROR_CODES.BAD_INPUT, 'Invalid join request.'));
      const result = joinRoom(store, { socketId: socket.id, code: data.code, name: data.name });
      if (!result.ok) {
        console.log(`[socket ${socket.id}] join rejected: ${result.code}`);
        return reply(ack, result);
      }
      const { room, player, duplicate } = result;
      socket.join(room.code);
      if (!duplicate) {
        startInputSession(inputs, player.id);
        log(room.code, `${player.name} joined (color ${player.colorIndex})`);
      }
      reply(
        ack,
        ackOk({
          playerId: player.id,
          reconnectToken: player.reconnectToken,
          room: toSnapshot(room),
        }),
      );
      if (!duplicate) broadcast(room);
    });

    socket.on(EVENTS.ROOM_REJOIN, (payload, ack) => {
      const data = asObject(payload);
      if (!data) return reply(ack, ackError(ERROR_CODES.BAD_INPUT, 'Invalid rejoin request.'));
      const result = rejoinRoom(store, {
        socketId: socket.id,
        code: data.code,
        playerId: data.playerId,
        reconnectToken: data.reconnectToken,
      });
      if (!result.ok) {
        console.log(`[socket ${socket.id}] rejoin rejected: ${result.code}`);
        return reply(ack, result);
      }
      const { room, player, previousSocketId } = result;
      if (previousSocketId && previousSocketId !== socket.id) {
        leaveSocketIoRoom(previousSocketId, room.code);
      }
      clearPlayerTimer(player.id);
      startInputSession(inputs, player.id);
      socket.join(room.code);
      log(room.code, `${player.name} reconnected`);
      reply(ack, ackOk({ playerId: player.id, room: toSnapshot(room) }));
      broadcast(room);
    });

    // High-frequency tilt input: no ack, anything malformed or over the rate limit is dropped.
    socket.on(EVENTS.PLAYER_INPUT, (payload) => {
      const playerId = playerIdFor(socket.id);
      if (!getLimiters(socket.id).input.tryAcquire()) {
        if (playerId) countDropped(inputs, playerId);
        return;
      }
      const input = parseInput(payload);
      if (!playerId) return;
      if (!input) {
        countDropped(inputs, playerId);
        return;
      }
      applyInput(inputs, playerId, input);
    });

    socket.on(EVENTS.PLAYER_SHAKE, (payload, ack) => {
      if (typeof payload === 'function') [payload, ack] = [undefined, payload];
      if (!getLimiters(socket.id).shake.tryAcquire()) {
        return reply(ack, ackError(ERROR_CODES.RATE_LIMITED, 'Too many shakes.'));
      }
      const shake = parseShake(payload);
      if (!shake) return reply(ack, ackError(ERROR_CODES.BAD_INPUT, 'Invalid shake.'));
      const binding = store.sockets.get(socket.id);
      const room = binding?.role === 'player' ? store.rooms.get(binding.code) : undefined;
      if (!room) return reply(ack, ackError(ERROR_CODES.BAD_INPUT, 'Join a room first.'));
      const result = applyShake(inputs, binding.playerId, shake.seq, {
        charging: room.phase === 'playing',
      });
      reply(ack, ackOk({ accepted: result.accepted, charge: result.charge }));
    });

    socket.on(EVENTS.GAME_START, (payload, ack) => {
      if (typeof payload === 'function') ack = payload;
      const result = startGame(store, socket.id);
      if (!result.ok) {
        console.log(`[socket ${socket.id}] game:start rejected: ${result.code}`);
        return reply(ack, result);
      }
      const { room } = result;
      // Phase change first, so clients switch views before the first game:state arrives.
      reply(ack, ackOk());
      broadcast(room);
      beginRound(room);
    });

    socket.on('disconnect', (reason) => {
      console.log(`[socket ${socket.id}] disconnected (${reason})`);
      limiters.delete(socket.id);
      const result = disconnectSocket(store, socket.id);
      if (!result) return;
      const { room } = result;

      if (result.role === 'host') {
        log(room.code, `host disconnected, closing in ${graceMs / 1000}s unless it returns`);
        clearHostTimer(room.code);
        hostTimers.set(
          room.code,
          setTimeout(() => {
            hostTimers.delete(room.code);
            if (store.rooms.get(room.code) === room && isHostExpired(room, Date.now(), 0)) {
              closeRoom(room.code, 'host_left');
            }
          }, graceMs),
        );
        return;
      }

      const { player } = result;
      log(room.code, `${player.name} disconnected (${graceMs / 1000}s grace)`);
      clearPlayerTimer(player.id);
      playerTimers.set(
        player.id,
        setTimeout(() => {
          playerTimers.delete(player.id);
          if (store.rooms.get(room.code) !== room) return;
          if (expirePlayer(room, player.id, Date.now(), 0)) {
            removeInputState(inputs, player.id);
            log(room.code, `${player.name} removed after grace period`);
            broadcast(room);
          }
        }, graceMs),
      );
      broadcast(room);
    });
  }

  function dispose() {
    clearInterval(inputLogTimer);
    for (const room of store.rooms.values()) stopGameLoop(room);
    for (const t of playerTimers.values()) clearTimeout(t);
    for (const t of hostTimers.values()) clearTimeout(t);
    playerTimers.clear();
    hostTimers.clear();
  }

  return { store, inputs, attach, dispose };
}

function main() {
  const port = Number.parseInt(process.env.PORT ?? '', 10) || 3001;
  const { httpServer, io, origins, limits } = createRumbleServer();

  httpServer.listen(port, () => {
    console.log(`[server] listening on http://localhost:${port}`);
    console.log(`[server] CORS origins: ${origins.join(', ')}`);
    console.log(
      `[server] players: min ${limits.minPlayers}, max ${limits.maxPlayers}` +
        (limits.isDev ? ' (development)' : ''),
    );
  });

  const shutdown = (signal) => {
    console.log(`[server] ${signal} received, shutting down`);
    io.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
