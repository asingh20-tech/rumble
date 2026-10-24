import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { RECONNECT_GRACE_MS, resolvePlayerLimits } from '@rumble/shared/constants';
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
  toSnapshot,
} from './rooms.js';

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

  return { app, httpServer, io, origins, limits, store: lobby.store };
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
 * Socket wiring for room:create / join / rejoin and disconnect grace periods.
 * Room state lives in rooms.js; this layer owns Socket.IO rooms, broadcasts and timers.
 * @param {import('socket.io').Server} io
 * @param {{ limits: { minPlayers: number, maxPlayers: number }, graceMs: number }} options
 */
export function createLobbyHandlers(io, { limits, graceMs }) {
  const store = createRoomStore();
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
    clearHostTimer(code);
    for (const playerId of room.players.keys()) clearPlayerTimer(playerId);
    io.to(code).emit(EVENTS.ROOM_CLOSED, { code, reason });
    io.in(code).socketsLeave(code);
    log(code, `closed (${reason})`);
  };

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
      if (!duplicate) log(room.code, `${player.name} joined (color ${player.colorIndex})`);
      reply(
        ack,
        ackOk({ playerId: player.id, reconnectToken: player.reconnectToken, room: toSnapshot(room) }),
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
      socket.join(room.code);
      log(room.code, `${player.name} reconnected`);
      reply(ack, ackOk({ playerId: player.id, room: toSnapshot(room) }));
      broadcast(room);
    });

    socket.on('disconnect', (reason) => {
      console.log(`[socket ${socket.id}] disconnected (${reason})`);
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
            log(room.code, `${player.name} removed after grace period`);
            broadcast(room);
          }
        }, graceMs),
      );
      broadcast(room);
    });
  }

  function dispose() {
    for (const t of playerTimers.values()) clearTimeout(t);
    for (const t of hostTimers.values()) clearTimeout(t);
    playerTimers.clear();
    hostTimers.clear();
  }

  return { store, attach, dispose };
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
