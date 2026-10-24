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

describe('lobby over sockets', () => {
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
  const next = (c, event) => new Promise((resolve) => c.once(event, resolve));

  beforeAll(async () => {
    server = createRumbleServer({
      env: { NODE_ENV: 'development', RECONNECT_GRACE_MS: '150' },
    });
    await new Promise((resolve) => server.httpServer.listen(0, resolve));
    baseUrl = `http://localhost:${server.httpServer.address().port}`;
  });

  afterAll(async () => {
    for (const c of clients) c.disconnect();
    await new Promise((resolve) => server.io.close(resolve));
  });

  it('create, join, rejoin, grace removal and host close', async () => {
    const host = await open();
    const created = await call(host, EVENTS.ROOM_CREATE, {});
    expect(created.ok).toBe(true);
    const { code } = created.room;

    const phone = await open();
    const update = next(host, EVENTS.ROOM_UPDATE);
    const joined = await call(phone, EVENTS.ROOM_JOIN, { code, name: ' <i>Ann</i> ' });
    expect(joined).toMatchObject({ ok: true, room: { code, canStart: true } });
    expect((await update).players[0]).toMatchObject({ name: 'Ann', colorIndex: 0 });

    // Duplicate join from the same socket doesn't add a second player.
    const dup = await call(phone, EVENTS.ROOM_JOIN, { code, name: 'Ann' });
    expect(dup.playerId).toBe(joined.playerId);
    expect(dup.room.players).toHaveLength(1);

    // Reload: new socket reclaims the seat with the token.
    const offline = next(host, EVENTS.ROOM_UPDATE);
    phone.disconnect();
    expect((await offline).players[0].connected).toBe(false);
    const phone2 = await open();
    const bad = await call(phone2, EVENTS.ROOM_REJOIN, {
      code,
      playerId: joined.playerId,
      reconnectToken: 'wrong',
    });
    expect(bad).toMatchObject({ ok: false, code: 'BAD_INPUT' });
    const re = await call(phone2, EVENTS.ROOM_REJOIN, {
      code,
      playerId: joined.playerId,
      reconnectToken: joined.reconnectToken,
    });
    expect(re).toMatchObject({ ok: true, playerId: joined.playerId });
    expect(re.room.players[0].connected).toBe(true);

    // Leaving for longer than the grace period removes the player from the lobby.
    phone2.disconnect();
    const removed = await new Promise((resolve) => {
      host.on(EVENTS.ROOM_UPDATE, (snap) => snap.players.length === 0 && resolve(snap));
    });
    expect(removed.players).toEqual([]);

    // Host gone past the grace period closes the room for everyone.
    const phone3 = await open();
    await call(phone3, EVENTS.ROOM_JOIN, { code, name: 'Ben' });
    const closed = next(phone3, EVENTS.ROOM_CLOSED);
    host.disconnect();
    expect(await closed).toEqual({ code, reason: 'host_left' });
    expect(server.store.rooms.has(code)).toBe(false);
    const late = await call(phone3, EVENTS.ROOM_JOIN, { code, name: 'Cy' });
    expect(late).toMatchObject({ ok: false, code: 'ROOM_NOT_FOUND' });
  });

  it('host can reclaim its room after a reload', async () => {
    const host = await open();
    const created = await call(host, EVENTS.ROOM_CREATE, {});
    host.disconnect();
    const host2 = await open();
    const back = await call(host2, EVENTS.ROOM_CREATE, {
      code: created.room.code,
      hostToken: created.hostToken,
    });
    expect(back.room.code).toBe(created.room.code);
    await new Promise((r) => setTimeout(r, 250));
    expect(server.store.rooms.has(created.room.code)).toBe(true);
  });

  it('rejects malformed payloads', async () => {
    const c = await open();
    expect(await call(c, EVENTS.ROOM_JOIN, 'nope')).toMatchObject({ ok: false, code: 'BAD_INPUT' });
    expect(await call(c, EVENTS.ROOM_REJOIN, null)).toMatchObject({ ok: false, code: 'BAD_INPUT' });
  });
});
