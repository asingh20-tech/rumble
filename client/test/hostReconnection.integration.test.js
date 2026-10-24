import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { io as connect } from 'socket.io-client';
import { EVENTS } from '@rumble/shared/protocol';
import { createRumbleServer } from '../../server/src/index.js';
import { createHostLobby, HOST_SESSION_KEY } from '../src/components/hostLobby.js';

// Use the real backend read-only. Each test gets its own server and browser storage.
describe('host recovery against the M2 backend', () => {
  let server, url, storage, logs;
  let sockets, subscriptions;
  const waitFor = (assertion) => vi.waitFor(assertion, { interval: 10, timeout: 3000 });
  const credentials = () => JSON.parse(storage.getItem(HOST_SESSION_KEY));
  function openHost() {
    const socket = connect(url, { transports: ['websocket'], forceNew: true, autoConnect: false, reconnection: false });
    sockets.push(socket);
    const emit = vi.spyOn(socket, 'emit');
    const lobby = createHostLobby(socket, storage);
    const stop = lobby.subscribe(() => {});
    subscriptions.push(stop);
    return { socket, lobby, stop, creates: () => emit.mock.calls.filter(([event]) => event === EVENTS.ROOM_CREATE) };
  }
  async function disconnectHost(host) {
    host.stop(); await Promise.resolve();
    const id = host.socket.id;
    host.socket.disconnect();
    await waitFor(() => expect(server.store.sockets.has(id)).toBe(false));
  }
  beforeEach(async () => {
    sockets = []; subscriptions = [];
    const data = new Map();
    storage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
    logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    server = createRumbleServer({ env: { NODE_ENV: 'development', RECONNECT_GRACE_MS: '1000' } });
    await new Promise((resolve, reject) => {
      server.httpServer.once('error', reject);
      server.httpServer.listen(0, '127.0.0.1', resolve);
    });
    url = `http://127.0.0.1:${server.httpServer.address().port}`;
  });
  afterEach(async () => {
    subscriptions.forEach((stop) => stop()); await Promise.resolve();
    sockets.forEach((socket) => socket.disconnect());
    if (server?.httpServer.listening) {
      await waitFor(() => expect(server.store.sockets.size).toBe(0));
      await new Promise((resolve) => server.io.close(resolve));
    }
    logs.mockRestore();
  });

  it('restores the same code and players when the host page is refreshed', async () => {
    const first = openHost();
    await waitFor(() => expect(first.lobby.getSnapshot().status).toBe('lobby'));
    const { code } = first.lobby.getSnapshot().room;
    expect(first.creates()).toHaveLength(1);
    expect(first.creates()[0][1]).toEqual({});
    const phone = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(phone);
    await waitFor(() => expect(phone.connected).toBe(true));
    const joined = await phone.timeout(2000).emitWithAck(EVENTS.ROOM_JOIN, { code, name: 'Rival' });
    expect(joined.ok).toBe(true);
    await waitFor(() => expect(first.lobby.getSnapshot().room.players).toHaveLength(1));
    await disconnectHost(first);
    const refreshed = openHost();
    await waitFor(() => expect(refreshed.lobby.getSnapshot().status).toBe('lobby'));
    expect(refreshed.lobby.getSnapshot().room).toMatchObject({ code, players: [{ id: joined.playerId, name: 'Rival', connected: true }] });
    expect(server.store.rooms.size).toBe(1);
    expect(refreshed.creates()).toHaveLength(1);
    expect(JSON.stringify(refreshed.lobby.getSnapshot()).includes(credentials().hostToken)).toBe(false);
    expect(logs.mock.calls.flat().some((line) => String(line).includes(credentials().hostToken))).toBe(false);
  });

  it('reclaims on brief socket disconnection without creating duplicate rooms', async () => {
    const host = openHost();
    await waitFor(() => expect(host.lobby.getSnapshot().status).toBe('lobby'));
    const saved = credentials();
    const id = host.socket.id;
    host.socket.disconnect();
    expect(host.lobby.getSnapshot().status).toBe('reconnecting');
    await waitFor(() => expect(server.store.sockets.has(id)).toBe(false));
    host.socket.connect();
    await waitFor(() => expect(host.lobby.getSnapshot().status).toBe('lobby'));
    expect(host.lobby.getSnapshot().room.code).toBe(saved.code);
    expect(server.store.rooms.size).toBe(1);
    expect(host.creates()).toHaveLength(2);
    const payload = host.creates()[1][1];
    expect(Object.keys(payload).sort()).toEqual(['code', 'hostToken']);
    expect(payload.code).toBe(saved.code);
    expect(payload.hostToken === saved.hostToken).toBe(true);
  });

  it('saves a new room and token when the previous room has expired', async () => {
    const first = openHost();
    await waitFor(() => expect(first.lobby.getSnapshot().status).toBe('lobby'));
    const saved = credentials();
    await disconnectHost(first);
    await waitFor(() => expect(server.store.rooms.has(saved.code)).toBe(false));
    const refreshed = openHost();
    await waitFor(() => expect(refreshed.lobby.getSnapshot().status).toBe('lobby'));
    const replacement = credentials();
    expect(replacement.code).not.toBe(saved.code);
    expect(replacement.hostToken !== saved.hostToken).toBe(true);
    expect(refreshed.lobby.getSnapshot().room.code).toBe(replacement.code);
    expect(server.store.rooms.size).toBe(1);
    expect(refreshed.lobby.getSnapshot().notice).toContain('Share the new room code');
  });

  it('saves replacement credentials when the stored token is invalid', async () => {
    const first = openHost();
    await waitFor(() => expect(first.lobby.getSnapshot().status).toBe('lobby'));
    const saved = credentials();
    await disconnectHost(first);
    storage.setItem(HOST_SESSION_KEY, JSON.stringify({ code: saved.code, hostToken: 'invalid-test-token' }));
    const refreshed = openHost();
    await waitFor(() => expect(refreshed.lobby.getSnapshot().status).toBe('lobby'));
    const replacement = credentials();
    expect(replacement.code).not.toBe(saved.code);
    expect(replacement.hostToken !== 'invalid-test-token').toBe(true);
    expect(refreshed.lobby.getSnapshot().room.code).toBe(replacement.code);
  });
});
