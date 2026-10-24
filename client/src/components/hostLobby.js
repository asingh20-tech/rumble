import { EVENTS, ERROR_CODES } from '@rumble/shared/protocol';

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
const messageFor = (result) => ERROR_MESSAGES[result?.code] || result?.message || 'Something went wrong. Please try again.';
const ACK_TIMEOUT_MS = 10000;

// A page owns one instance. A microtask defers disposal through StrictMode's
// subscribe → unsubscribe → subscribe replay, so creation is sent only once.
export function createHostLobby(socket) {
  let state = { room: null, status: 'creating', error: '', connected: socket.connected, starting: false, startAccepted: false };
  let active = false;
  let createSent = false;
  let createTimer;
  let startTimer;
  let startRequest = 0;
  const subscribers = new Set();
  function update(patch) {
    state = { ...state, ...patch };
    subscribers.forEach((listener) => listener());
  }
  function onConnect() {
    update({ connected: true });
    if (createSent || state.status === 'closed') return;
    createSent = true;
    socket.emit(EVENTS.ROOM_CREATE, {}, (result) => {
      if (!active || state.status === 'closed') return;
      clearTimeout(createTimer);
      if (result?.ok) update({ room: result.room, status: 'lobby', error: '' });
      else update({ status: 'error', error: messageFor(result) });
    });
  }
  function onDisconnect() {
    clearTimeout(startTimer);
    startRequest++;
    update({ connected: false, starting: false, ...(createSent ? {
      status: 'closed', room: null,
      error: 'The host connection was lost. Create a new lobby and share the new code.',
    } : {}) });
    if (createSent) clearTimeout(createTimer);
  }
  function onConnectError() {
    update({ connected: false, error: 'Cannot reach the server. Check your connection; we’ll keep trying.' });
  }
  function onRoomUpdate(room) {
    if (state.status !== 'closed' && room.code === state.room?.code) update({ room });
  }
  function onRoomClosed(payload) {
    if (payload.code !== state.room?.code) return;
    clearTimeout(createTimer);
    clearTimeout(startTimer);
    startRequest++;
    update({ room: null, status: 'closed', starting: false,
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
        createTimer = setTimeout(() => {
          if (!active || state.room || state.status === 'closed') return;
          update({ status: 'timeout', error: 'Creating the room is taking longer than expected. The lobby server may not be ready yet. You can wait here or reload to try again.' });
        }, ACK_TIMEOUT_MS);
        if (socket.connected) onConnect();
        else if (!socket.active) socket.connect();
      }
      return () => {
        subscribers.delete(listener);
        queueMicrotask(() => {
          if (subscribers.size || !active) return;
          active = false;
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
