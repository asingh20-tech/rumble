import { EVENTS, ERROR_CODES } from '@rumble/shared/protocol';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@rumble/shared/constants';

const ERROR_MESSAGES = {
  [ERROR_CODES.ROOM_NOT_FOUND]: 'This room no longer exists. Create a new lobby.',
  [ERROR_CODES.ROOM_FULL]: 'This room is full.',
  [ERROR_CODES.GAME_IN_PROGRESS]: 'The game is already in progress.',
  [ERROR_CODES.INVALID_NAME]: 'A player nickname was not accepted.',
  [ERROR_CODES.NOT_HOST]: 'Only this room’s host can start the game.',
  [ERROR_CODES.NOT_ENOUGH_PLAYERS]: 'More connected players are needed to start.',
  [ERROR_CODES.RATE_LIMITED]: 'Too many requests. Wait a moment and try again.',
  [ERROR_CODES.BAD_INPUT]: 'The server could not accept that request.',
};
const messageFor = (result) => ERROR_MESSAGES[result?.code] || 'Something went wrong. Please try again.';
const ACK_TIMEOUT_MS = 10000;
export const HOST_SESSION_KEY = 'rumble:host-session';

function readCredentials(storage) {
  try {
    const value = JSON.parse(storage?.getItem(HOST_SESSION_KEY) ?? 'null');
    if (typeof value?.code === 'string' && value.code.length === ROOM_CODE_LENGTH &&
        [...value.code].every((char) => ROOM_CODE_ALPHABET.includes(char)) &&
        typeof value.hostToken === 'string' && value.hostToken) {
      return { code: value.code, hostToken: value.hostToken };
    }
  } catch { /* Broken or unavailable storage must not prevent hosting. */ }
  clearCredentials(storage);
  return null;
}
function clearCredentials(storage) {
  try { storage?.removeItem(HOST_SESSION_KEY); } catch { /* Storage can be disabled. */ }
}
function saveCredentials(storage, credentials) {
  try {
    if (!storage) return false;
    storage.setItem(HOST_SESSION_KEY, JSON.stringify(credentials));
    return true;
  } catch { return false; }
}

// A page owns one instance. Deferred disposal bridges StrictMode's subscription
// replay; one create/reclaim request is sent per socket connection.
export function createHostLobby(socket, storage) {
  let credentials = readCredentials(storage);
  let state = { room: null, status: credentials ? 'restoring' : 'creating', error: '', notice: '',
    connected: socket.connected, starting: false, startAccepted: false };
  let active = false;
  let createSent = false;
  let createRequest = 0;
  let createTimer;
  let startTimer;
  let startRequest = 0;
  const subscribers = new Set();
  function update(patch) {
    state = { ...state, ...patch };
    subscribers.forEach((listener) => listener());
  }
  function waitForRoom() {
    clearTimeout(createTimer);
    createTimer = setTimeout(() => {
      if (!active || state.status === 'lobby' || state.status === 'closed') return;
      update({ status: 'timeout', error: 'The lobby server is taking longer than expected. You can wait here or reload to reconnect.' });
    }, ACK_TIMEOUT_MS);
  }
  function onConnect() {
    update({ connected: true });
    if (createSent || state.status === 'closed') return;
    createSent = true;
    const request = ++createRequest;
    // Re-read persisted credentials on reconnect; retain the in-memory copy if
    // browser storage was blocked or became unavailable during the session.
    credentials = readCredentials(storage) ?? credentials;
    const previousCode = credentials?.code;
    update({ status: credentials ? 'restoring' : 'creating', error: '' });
    waitForRoom();
    socket.emit(EVENTS.ROOM_CREATE, credentials ?? {}, (result) => {
      if (!active || request !== createRequest || state.status === 'closed') return;
      clearTimeout(createTimer);
      if (!result?.ok) {
        update({ status: 'error', error: messageFor(result) });
        return;
      }
      credentials = { code: result.room.code, hostToken: result.hostToken };
      const persisted = saveCredentials(storage, credentials);
      const replaced = previousCode && previousCode !== result.room.code;
      update({ room: result.room, status: 'lobby', error: '',
        startAccepted: !['lobby', 'results'].includes(result.room.phase),
        notice: [
          replaced ? 'Your previous lobby is no longer available. Share the new room code with your players.' : '',
          persisted ? '' : 'Browser storage is unavailable. Keep this tab open; refreshing may create a new room.',
        ].filter(Boolean).join(' ') });
    });
  }
  function onDisconnect() {
    clearTimeout(createTimer);
    clearTimeout(startTimer);
    createRequest++;
    startRequest++;
    createSent = false;
    update({ connected: false, starting: false,
      ...(state.status === 'closed' ? {} : {
        status: 'reconnecting', error: 'Connection lost. Reconnecting to your lobby…',
      }) });
  }
  function onConnectError() {
    update({ connected: false, error: 'Cannot reach the server. Check your connection; we’ll keep trying.' });
  }
  function onRoomUpdate(room) {
    if (state.status !== 'closed' && room.code === state.room?.code) update({ room });
  }
  function onRoomClosed(payload) {
    if (payload.code !== (state.room?.code ?? credentials?.code)) return;
    clearTimeout(createTimer);
    clearTimeout(startTimer);
    createRequest++;
    startRequest++;
    credentials = null;
    clearCredentials(storage);
    update({ room: null, status: 'closed', starting: false, notice: '',
      error: payload.reason === 'host_left' ? 'The host left, so this room has closed.' : 'This room has expired. Create a new lobby.' });
  }
  const onError = (result) => update({ error: messageFor(result) });
  const listeners = [['connect', onConnect], ['disconnect', onDisconnect], ['connect_error', onConnectError],
    [EVENTS.ROOM_UPDATE, onRoomUpdate], [EVENTS.ROOM_CLOSED, onRoomClosed], [EVENTS.ERROR, onError]];
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      subscribers.add(listener);
      if (!active) {
        active = true;
        listeners.forEach(([event, handler]) => socket.on(event, handler));
        waitForRoom();
        if (socket.connected) onConnect();
        else if (!socket.active) socket.connect();
      }
      return () => {
        subscribers.delete(listener);
        queueMicrotask(() => {
          if (subscribers.size || !active) return;
          active = false;
          createSent = false;
          createRequest++;
          startRequest++;
          clearTimeout(createTimer);
          clearTimeout(startTimer);
          listeners.forEach(([event, handler]) => socket.off(event, handler));
        });
      };
    },
    start() {
      if (!active || !state.connected || !state.room?.canStart || state.starting || state.startAccepted || state.status !== 'lobby') return;
      const request = ++startRequest;
      update({ starting: true, error: '' });
      startTimer = setTimeout(() => {
        if (!active || request !== startRequest) return;
        startRequest++;
        update({ starting: false, startAccepted: true, error: 'The server did not confirm the start request. Wait for the host screen to update before trying again.' });
      }, ACK_TIMEOUT_MS);
      socket.emit(EVENTS.GAME_START, {}, (result) => {
        if (!active || request !== startRequest || state.status === 'closed') return;
        clearTimeout(startTimer);
        update({ starting: false, startAccepted: Boolean(result?.ok), error: result?.ok ? '' : messageFor(result) });
      });
    },
  };
}
