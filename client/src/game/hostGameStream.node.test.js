import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { EVENTS } from '@rumble/shared/protocol';
import { createHostGameStream } from '../components/hostGameStream.js';
import { MAX_BUFFERED_SNAPSHOTS } from './SnapshotInterpolation.js';

function fixture() {
  const socket = new EventEmitter();
  const listeners = new Set();
  let state = { connected: true, status: 'lobby', room: { code: 'ABC234', phase: 'playing', round: 1, players: [{ id: 'a', name: 'Rival', colorIndex: 2 }] } };
  const lobby = { getSnapshot: () => state, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const received = [], resets = [];
  const canvas = { setState: (...args) => received.push(args), reset: () => resets.push(true) };
  const stream = createHostGameStream({ socket, lobby, now: () => 123 });
  const stop = stream.start(); stream.setCanvas(canvas);
  return { socket, lobby, stream, stop, received, resets, listeners,
    update(patch) { state = { ...state, ...patch }; listeners.forEach((fn) => fn()); } };
}
const packet = (tick = 1) => ({ tick, serverTime: 1000 + tick * 33, timeLeftMs: 50000, players: [{ id: 'a', x: 100, y: 200, vx: 0, vy: 0, charge: 0, alive: true, connected: true }], events: [] });

test('forwards protocol state directly with only room-owned name/color metadata added', () => {
  const f = fixture(); const input = packet();
  f.socket.emit(EVENTS.GAME_STATE, input);
  assert.deepEqual(f.received[0], [{ ...input, players: [{ ...input.players[0], name: 'Rival', colorIndex: 2 }] }, 123]);
  assert.equal(input.players[0].name, undefined);
  f.stop();
});

test('does not notify room/React subscribers for a stream of game frames', () => {
  const f = fixture(); let notifications = 0;
  const unsubscribe = f.lobby.subscribe(() => notifications++);
  for (let i = 0; i < 100; i++) f.socket.emit(EVENTS.GAME_STATE, packet(i));
  assert.equal(f.received.length, 100); assert.equal(notifications, 0);
  unsubscribe(); f.stop();
});

test('replays a bounded history when the canvas mounts after the playing update', () => {
  const f = fixture(); f.stream.setCanvas(null);
  for (let i = 0; i < 20; i++) f.socket.emit(EVENTS.GAME_STATE, packet(i));
  f.stream.setCanvas({ setState: (...args) => f.received.push(args), reset() {} });
  assert.equal(f.received.length, MAX_BUFFERED_SNAPSHOTS);
  assert.equal(f.received.at(-1)[0].tick, 19); f.stop();
});

test('uses fresh room metadata, including when it arrives after the position tick', () => {
  const f = fixture();
  f.update({ room: { ...f.lobby.getSnapshot().room, players: [] } });
  f.socket.emit(EVENTS.GAME_STATE, packet());
  assert.equal(f.received.at(-1)[0].players[0].name, undefined);
  f.update({ room: { ...f.lobby.getSnapshot().room, players: [{ id: 'a', name: 'Updated', colorIndex: 4 }] } });
  assert.equal(f.received.at(-1)[0].players[0].name, 'Updated');
  assert.equal(f.received.at(-1)[0].players[0].colorIndex, 4); f.stop();
});

test('ignores non-playing, disconnected, duplicate and out-of-order packets', () => {
  const f = fixture();
  f.update({ connected: false }); f.socket.emit(EVENTS.GAME_STATE, packet());
  f.update({ connected: true, room: { ...f.lobby.getSnapshot().room, phase: 'lobby' } });
  f.socket.emit(EVENTS.GAME_STATE, packet()); assert.equal(f.received.length, 0);
  f.update({ room: { ...f.lobby.getSnapshot().room, phase: 'playing' } });
  f.socket.emit(EVENTS.GAME_STATE, packet(2)); f.socket.emit(EVENTS.GAME_STATE, packet(2)); f.socket.emit(EVENTS.GAME_STATE, packet(1));
  assert.equal(f.received.length, 1); f.stop();
});

test('resets old state for a new round/room and cleans up only its own listeners', () => {
  const f = fixture(); const unrelated = () => {};
  f.socket.on(EVENTS.GAME_STATE, unrelated);
  f.socket.emit(EVENTS.GAME_STATE, packet(5));
  f.update({ room: { ...f.lobby.getSnapshot().room, round: 2 } });
  f.socket.emit(EVENTS.GAME_STATE, packet(0));
  assert.equal(f.received.at(-1)[0].tick, 0);
  f.stop();
  assert.equal(f.socket.listenerCount(EVENTS.GAME_STATE), 1);
  assert.equal(f.listeners.size, 0);
  const count = f.received.length;
  f.socket.emit(EVENTS.GAME_STATE, packet(10)); assert.equal(f.received.length, count);
  const again = f.stream.start(); assert.equal(f.socket.listenerCount(EVENTS.GAME_STATE), 2);
  again(); assert.equal(f.socket.listenerCount(EVENTS.GAME_STATE), 1);
});
