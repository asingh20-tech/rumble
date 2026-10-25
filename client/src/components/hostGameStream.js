import { EVENTS } from '@rumble/shared/protocol';
import { MAX_BUFFERED_SNAPSHOTS } from '../game/SnapshotInterpolation.js';

/** Bridge snapshots to Phaser without putting 30 Hz game data in React state. */
export function createHostGameStream({ socket, lobby, now = () => performance.now() }) {
  let canvas = null;
  let active = false;
  let stopRoom = null;
  let roomKey = null;
  let previousRoom = null;
  let pending = [];

  function enrich(snapshot, room) {
    const summaries = new Map(room.players.map((player) => [player.id, player]));
    return { ...snapshot, players: snapshot.players.map((player) => {
      if (!summaries.has(player.id)) return { ...player };
      const { name, colorIndex } = summaries.get(player.id);
      return { ...player, name, colorIndex };
    }) };
  }
  function onRoom() {
    const { room } = lobby.getSnapshot();
    const key = room ? `${room.code}:${room.round}:${room.phase}` : null;
    if (key !== roomKey) {
      roomKey = key;
      pending = [];
      canvas?.reset();
    }
    if (room?.phase === 'playing' && room !== previousRoom && pending.length) {
      const last = pending.at(-1);
      // Same tick: refresh names/colors without adding another position sample.
      canvas?.setState(enrich(last.snapshot, room), last.receivedAt);
    }
    previousRoom = room;
  }
  function onGameState(snapshot) {
    const { room, connected, status } = lobby.getSnapshot();
    if (room?.phase !== 'playing' || !connected || status !== 'lobby' ||
        !Array.isArray(snapshot?.players) || !Number.isFinite(snapshot.serverTime) || !Number.isInteger(snapshot.tick) || snapshot.tick < 0) return;
    const last = pending.at(-1)?.snapshot;
    if (last && (snapshot.tick <= last.tick || snapshot.serverTime <= last.serverTime)) return;
    const frame = { snapshot, receivedAt: now() };
    pending.push(frame);
    pending = pending.slice(-MAX_BUFFERED_SNAPSHOTS);
    canvas?.setState(enrich(snapshot, room), frame.receivedAt);
  }
  return {
    setCanvas(nextCanvas) {
      canvas = nextCanvas;
      const { room } = lobby.getSnapshot();
      if (canvas && room?.phase === 'playing') {
        for (const frame of pending) canvas.setState(enrich(frame.snapshot, room), frame.receivedAt);
      }
    },
    start() {
      if (active) return () => {};
      active = true;
      socket.on(EVENTS.GAME_STATE, onGameState);
      stopRoom = lobby.subscribe(onRoom);
      onRoom();
      return () => {
        if (!active) return;
        active = false;
        socket.off(EVENTS.GAME_STATE, onGameState);
        stopRoom?.();
        stopRoom = null;
      };
    },
  };
}
