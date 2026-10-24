import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVENTS, ERROR_CODES } from '@rumble/shared/protocol';
import { createHostLobby, HOST_SESSION_KEY } from '../src/components/hostLobby.js';

const player = { id: 'p1', name: 'Rival', colorIndex: 0, joinOrder: 0, connected: true, roundWins: 0, knockouts: 0, survivalMs: 0 };
const room = { code: 'ABC234', phase: 'lobby', players: [player], minPlayers: 4, maxPlayers: 8, round: 0, canStart: false };
const credentials = { code: room.code, hostToken: 'test-host-secret' };
const cleanups = [];
function makeStorage(initial) {
  const data = new Map(initial ? [[HOST_SESSION_KEY, JSON.stringify(initial)]] : []);
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
}
function setup({ storage = makeStorage(), connected = true } = {}) {
  const handlers = new Map();
  const socket = {
    connected, active: false, emit: vi.fn(), connect: vi.fn(),
    on(event, fn) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); },
    off(event, fn) { handlers.get(event)?.delete(fn); },
  };
  const lobby = createHostLobby(socket, storage);
  const stop = lobby.subscribe(() => {});
  cleanups.push(stop);
  return { lobby, socket, storage, handlers, stop,
    fire: (event, payload) => handlers.get(event)?.forEach((fn) => fn(payload)),
    ack: (result) => socket.emit.mock.calls.at(-1)[2](result) };
}
afterEach(async () => {
  cleanups.splice(0).forEach((stop) => stop());
  await Promise.resolve();
  vi.useRealTimers();
});

describe('host room lifecycle', () => {
  it('creates once across StrictMode replay and repeated subscriptions', async () => {
    const s = setup();
    s.stop(); cleanups.push(s.lobby.subscribe(() => {}));
    await Promise.resolve();
    cleanups.push(s.lobby.subscribe(() => {}));
    expect(s.socket.emit).toHaveBeenCalledExactlyOnceWith(EVENTS.ROOM_CREATE, {}, expect.any(Function));
    s.ack({ ok: true, room, hostToken: credentials.hostToken });
    expect(JSON.parse(s.storage.getItem(HOST_SESSION_KEY))).toEqual(credentials);
    expect(s.lobby.getSnapshot()).toMatchObject({ room, status: 'lobby' });
    expect(JSON.stringify(s.lobby.getSnapshot())).not.toContain(credentials.hostToken);
    expect(JSON.stringify(s.lobby.getSnapshot())).not.toContain('hostToken');
  });

  it('restores the same code and players after a page reload', async () => {
    const storage = makeStorage();
    const first = setup({ storage });
    first.ack({ ok: true, room, hostToken: credentials.hostToken });
    first.stop(); await Promise.resolve();
    const refreshed = setup({ storage });
    expect(refreshed.socket.emit).toHaveBeenCalledExactlyOnceWith(EVENTS.ROOM_CREATE, credentials, expect.any(Function));
    refreshed.ack({ ok: true, room, hostToken: credentials.hostToken });
    expect(refreshed.lobby.getSnapshot().room).toEqual(room);
    expect(refreshed.lobby.getSnapshot().room.players).toEqual([player]);
  });

  it('keeps the lobby while disconnected and sends one reclaim on reconnect', () => {
    const s = setup();
    s.ack({ ok: true, room: { ...room, canStart: true }, hostToken: credentials.hostToken });
    s.socket.connected = false; s.fire('disconnect');
    expect(s.lobby.getSnapshot()).toMatchObject({ room: { code: room.code, players: [player] }, status: 'reconnecting' });
    s.lobby.start(); expect(s.socket.emit).toHaveBeenCalledTimes(1);
    s.socket.connected = true; s.fire('connect'); s.fire('connect');
    expect(s.socket.emit).toHaveBeenCalledTimes(2);
    expect(s.socket.emit).toHaveBeenLastCalledWith(EVENTS.ROOM_CREATE, credentials, expect.any(Function));
    s.ack({ ok: true, room, hostToken: credentials.hostToken });
    expect(s.lobby.getSnapshot().status).toBe('lobby');
  });

  it('re-reads storage on reconnect and transmits only code and hostToken', () => {
    const s = setup({ storage: makeStorage({ ...credentials, extra: 'ignore' }) });
    expect(s.socket.emit).toHaveBeenLastCalledWith(EVENTS.ROOM_CREATE, credentials, expect.any(Function));
    s.ack({ ok: true, room, hostToken: credentials.hostToken });
    s.fire('disconnect');
    const updated = { ...credentials, hostToken: 'updated-test-secret' };
    s.storage.setItem(HOST_SESSION_KEY, JSON.stringify(updated));
    s.fire('connect');
    expect(s.socket.emit).toHaveBeenLastCalledWith(EVENTS.ROOM_CREATE, updated, expect.any(Function));
  });

  it('saves replacement credentials after the server replaces the previous room', () => {
    const s = setup({ storage: makeStorage(credentials) });
    const replacement = { ...room, code: 'DEF567', players: [] };
    s.ack({ ok: true, room: replacement, hostToken: 'replacement-test-secret' });
    expect(JSON.parse(s.storage.getItem(HOST_SESSION_KEY))).toEqual({ code: replacement.code, hostToken: 'replacement-test-secret' });
    expect(s.lobby.getSnapshot().room).toEqual(replacement);
    expect(s.lobby.getSnapshot().notice).toContain('Share the new room code');
  });

  it('ignores late acknowledgements from a previous socket connection', () => {
    const s = setup({ storage: makeStorage(credentials) });
    const staleAck = s.socket.emit.mock.calls[0][2];
    s.fire('disconnect'); s.fire('connect');
    s.ack({ ok: true, room, hostToken: credentials.hostToken });
    staleAck({ ok: true, room: { ...room, code: 'DEF567' }, hostToken: 'stale-test-secret' });
    expect(s.lobby.getSnapshot().room.code).toBe(room.code);
    expect(JSON.parse(s.storage.getItem(HOST_SESSION_KEY))).toEqual(credentials);
  });

  it('ignores other rooms and forgets credentials on room closure', () => {
    const s = setup({ storage: makeStorage(credentials) });
    s.ack({ ok: true, room, hostToken: credentials.hostToken });
    s.fire(EVENTS.ROOM_CLOSED, { code: 'DEF567', reason: 'expired' });
    expect(s.lobby.getSnapshot().status).toBe('lobby');
    s.fire(EVENTS.ROOM_CLOSED, { code: room.code, reason: 'expired' });
    expect(s.storage.getItem(HOST_SESSION_KEY)).toBeNull();
    expect(s.lobby.getSnapshot()).toMatchObject({ status: 'closed', room: null });
    s.fire('disconnect'); s.fire('connect'); expect(s.socket.emit).toHaveBeenCalledTimes(1);
  });

  it.each(['{bad json', JSON.stringify({ code: 'bad', hostToken: 'test' }), JSON.stringify({ code: room.code })])('discards malformed saved credentials: %s', (raw) => {
    const storage = makeStorage(); storage.setItem(HOST_SESSION_KEY, raw);
    const s = setup({ storage });
    expect(s.socket.emit).toHaveBeenLastCalledWith(EVENTS.ROOM_CREATE, {}, expect.any(Function));
    expect(storage.getItem(HOST_SESSION_KEY)).toBeNull();
  });

  it('permits hosting and in-memory recovery when storage is blocked', () => {
    const storage = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); }, removeItem() { throw Error('blocked'); } };
    const s = setup({ storage });
    s.ack({ ok: true, room, hostToken: credentials.hostToken });
    expect(s.lobby.getSnapshot().notice).toContain('storage is unavailable');
    s.fire('disconnect'); s.fire('connect');
    expect(s.socket.emit).toHaveBeenLastCalledWith(EVENTS.ROOM_CREATE, credentials, expect.any(Function));
  });

  it('removes listeners and ignores late acknowledgements after unmount', async () => {
    const s = setup();
    s.stop(); await Promise.resolve();
    expect([...s.handlers.values()].every((listeners) => listeners.size === 0)).toBe(true);
    s.ack({ ok: true, room, hostToken: credentials.hostToken });
    expect(s.lobby.getSnapshot().room).toBeNull();
    expect(s.storage.getItem(HOST_SESSION_KEY)).toBeNull();
  });

  it('waits for a connection before emitting and preserves credentials on errors', () => {
    const s = setup({ connected: false, storage: makeStorage(credentials) });
    expect(s.socket.emit).not.toHaveBeenCalled();
    expect(s.socket.connect).toHaveBeenCalledOnce();
    s.socket.connected = true; s.fire('connect');
    s.ack({ ok: false, code: ERROR_CODES.RATE_LIMITED });
    expect(s.lobby.getSnapshot().status).toBe('error');
    expect(JSON.parse(s.storage.getItem(HOST_SESSION_KEY))).toEqual(credentials);
  });

  it('shows a timeout without duplicating requests and accepts a late creation reply', () => {
    vi.useFakeTimers();
    const s = setup();
    vi.advanceTimersByTime(10000);
    expect(s.lobby.getSnapshot().status).toBe('timeout');
    s.fire('connect'); expect(s.socket.emit).toHaveBeenCalledTimes(1);
    s.ack({ ok: true, room, hostToken: credentials.hostToken });
    expect(s.lobby.getSnapshot().status).toBe('lobby');
  });

  it('preserves roster updates and START acknowledgement errors without double clicks', () => {
    const s = setup();
    s.ack({ ok: true, room, hostToken: credentials.hostToken });
    s.lobby.start(); expect(s.socket.emit).toHaveBeenCalledTimes(1);
    s.fire(EVENTS.ROOM_UPDATE, { ...room, code: 'DEF567', players: [] });
    expect(s.lobby.getSnapshot().room.players).toEqual([player]);
    s.fire(EVENTS.ROOM_UPDATE, { ...room, canStart: true });
    s.lobby.start(); s.lobby.start(); expect(s.socket.emit).toHaveBeenCalledTimes(2);
    expect(s.socket.emit).toHaveBeenLastCalledWith(EVENTS.GAME_START, {}, expect.any(Function));
    s.ack({ ok: false, code: ERROR_CODES.NOT_ENOUGH_PLAYERS });
    expect(s.lobby.getSnapshot().error).toContain('More connected players');
  });

  it('never forwards unknown server errors that could contain credentials into the UI', () => {
    const s = setup();
    s.ack({ ok: false, message: credentials.hostToken });
    expect(s.lobby.getSnapshot().error).not.toContain(credentials.hostToken);
    s.fire(EVENTS.ERROR, { message: credentials.hostToken });
    expect(s.lobby.getSnapshot().error).not.toContain(credentials.hostToken);
  });
});
