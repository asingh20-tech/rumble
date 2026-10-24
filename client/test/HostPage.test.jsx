import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { socket } from '../src/network/socket.js';
import { createHostLobby } from '../src/components/hostLobby.js';
import HostPage from '../src/pages/HostPage.jsx';

vi.mock('../src/network/socket.js', () => ({ socket: {} }));
vi.mock('../src/components/hostLobby.js', () => ({ createHostLobby: vi.fn() }));
vi.mock('qrcode.react', () => ({ QRCodeSVG: ({ value }) => <svg data-qr-value={value} /> }));
const player = { id: 'p1', name: 'Rival', colorIndex: 0, connected: true };
const room = { code: 'ABC234', phase: 'lobby', players: [player], minPlayers: 4, maxPlayers: 8, round: 0, canStart: false };
let snapshot, storage;
const render = () => renderToStaticMarkup(<MemoryRouter><HostPage /></MemoryRouter>);
beforeEach(() => {
  storage = { getItem: () => JSON.stringify({ code: room.code, hostToken: 'private-test-secret' }) };
  vi.stubGlobal('window', { localStorage: storage, location: { origin: 'https://rumble.example', hostname: 'rumble.example' } });
  vi.stubEnv('VITE_PUBLIC_URL', '');
  snapshot = { room, status: 'lobby', connected: true, starting: false, startAccepted: false, error: '', notice: '' };
  vi.mocked(createHostLobby).mockImplementation(() => ({ getSnapshot: () => snapshot, subscribe: () => () => {}, start: vi.fn() }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('host reconnection UI', () => {
  it('preserves the code, roster, QR and player count without exposing host credentials', () => {
    const markup = render();
    for (const text of ['ABC234', 'Rival', '1 / 8', 'Need 3 more players']) expect(markup).toContain(text);
    expect(markup).toContain('data-qr-value="https://rumble.example/play/ABC234"');
    expect(markup).not.toContain('private-test-secret');
    expect(markup).not.toContain('hostToken');
    expect(createHostLobby).toHaveBeenCalledWith(socket, storage);
  });

  it('keeps existing players visible and START disabled until reclaim completes', () => {
    snapshot = { ...snapshot, room: { ...room, canStart: true }, status: 'restoring' };
    const markup = render();
    expect(markup).toContain('Rival'); expect(markup).toContain('RECONNECTING…');
    expect(markup).toMatch(/<button[^>]*disabled/);
    snapshot = { ...snapshot, status: 'lobby' };
    expect(render()).not.toMatch(/<button[^>]*disabled/);
  });

  it('shows recovery progress, replacement-room notices and closed-room feedback', () => {
    snapshot = { ...snapshot, room: null, status: 'restoring' };
    expect(render()).toContain('Restoring your lobby…');
    snapshot = { ...snapshot, room: { ...room, code: 'DEF567' }, status: 'lobby', notice: 'Share the new room code.' };
    const replacement = render();
    expect(replacement).toContain('Share the new room code.');
    expect(replacement).toContain('https://rumble.example/play/DEF567');
    snapshot = { ...snapshot, room: null, status: 'closed', error: 'This room has expired.' };
    expect(render()).toContain('Room closed');
    expect(render()).toContain('This room has expired.');
  });

  it('continues rendering if the localStorage property itself is blocked', () => {
    Object.defineProperty(window, 'localStorage', { get() { throw Error('blocked'); } });
    expect(render()).toContain('ABC234');
    expect(createHostLobby).toHaveBeenCalledWith(socket, undefined);
  });

  it('respects VITE_PUBLIC_URL and keeps credentials out of the QR target', () => {
    vi.stubEnv('VITE_PUBLIC_URL', 'https://public.example/');
    expect(render()).toContain('data-qr-value="https://public.example/play/ABC234"');
  });
});
