import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as connect } from 'socket.io-client';
import { EVENTS } from '@rumble/shared/protocol';
import { createRumbleServer, parseOrigins } from '../src/index.js';

describe('server', () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    server = createRumbleServer({ env: { CLIENT_ORIGIN: 'http://localhost:5173' } });
    await new Promise((resolve) => server.httpServer.listen(0, resolve));
    baseUrl = `http://localhost:${server.httpServer.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.io.close(resolve));
  });

  it('GET /health returns {ok:true}', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('sends CORS header for the configured origin only', async () => {
    const allowed = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');

    const denied = await fetch(`${baseUrl}/health`, { headers: { Origin: 'http://evil.test' } });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('accepts socket connections and survives a client-sent error event', async () => {
    const client = connect(baseUrl, { transports: ['websocket'], forceNew: true });
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('connect_error', reject);
    });
    client.emit(EVENTS.ERROR, { code: 'BAD_INPUT', message: 'spoofed' });
    await new Promise((r) => setTimeout(r, 50));
    expect(client.connected).toBe(true);
    client.disconnect();

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  it('parses CLIENT_ORIGIN lists', () => {
    expect(parseOrigins(undefined)).toEqual(['http://localhost:5173']);
    expect(parseOrigins('https://a.app/, https://b.app')).toEqual([
      'https://a.app',
      'https://b.app',
    ]);
  });
});
