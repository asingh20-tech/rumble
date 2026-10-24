import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { resolvePlayerLimits } from '@rumble/shared/constants';

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

  io.on('connection', (socket) => {
    console.log(`[socket ${socket.id}] connected`);
    socket.on('disconnect', (reason) => {
      console.log(`[socket ${socket.id}] disconnected (${reason})`);
    });
  });

  return { app, httpServer, io, origins, limits };
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
