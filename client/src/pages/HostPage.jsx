import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { socket } from '../network/socket.js';
import { createHostLobby } from '../components/hostLobby.js';
import PlayerCard from '../components/PlayerCard.jsx';
import RoomQRCode from '../components/RoomQRCode.jsx';
import { createHostGameStream } from '../components/hostGameStream.js';
import GameCanvas from '../game/GameCanvas.jsx';

export default function HostPage() {
  const [lobby] = useState(() => {
    let storage;
    try { storage = window.localStorage; } catch { /* Hosting still works when storage is blocked. */ }
    return createHostLobby(socket, storage);
  });
  const { room, status, error, notice, connected, starting, startAccepted } = useSyncExternalStore(lobby.subscribe, lobby.getSnapshot, lobby.getSnapshot);
  const gameStream = useMemo(() => createHostGameStream({ socket, lobby }), [lobby]);
  const setCanvas = useCallback((canvas) => gameStream.setCanvas(canvas), [gameStream]);
  useEffect(() => gameStream.start(), [gameStream]);
  const restoring = status === 'restoring' || status === 'reconnecting';
  const connectedPlayers = room?.players.filter((player) => player.connected).length ?? 0;
  const missingPlayers = room ? Math.max(0, room.minPlayers - connectedPlayers) : 0;
  const isLocalhost = ['localhost', '127.0.0.1'].includes(window.location.hostname);

  return (
    <main className="arcade-page host-page">
      <header className="arcade-header">
        <Link className="arcade-brand" to="/">RUMBLE<span aria-hidden="true">✳</span></Link>
        <p className="arcade-eyebrow">{room?.phase === 'playing' ? 'THE ARENA / STAY IN THE RING' : 'THE LOBBY / BRING YOUR RIVALS'}</p>
      </header>
      {isLocalhost && <p className="lobby-notice" role="status">Phones can't reach localhost. Open the tunnel URL instead.</p>}
      {error && <p className="lobby-notice" role="alert">{error}</p>}
      {notice && <p className="lobby-notice" role="status">{notice}</p>}
      {room?.phase === 'playing' ? (
        <section className="host-game" aria-label="Live game">
          <div className="host-game-heading">
            <div><p className="arcade-eyebrow text-neon-cyan">ROOM {room.code}</p><h1>ROUND {room.round}</h1></div>
            <p>{connectedPlayers} / {room.maxPlayers} connected</p>
          </div>
          <GameCanvas ref={setCanvas} />
          <p className="host-game-caption">Your phones control the action. Keep your eyes on the arena.</p>
        </section>
      ) : room ? (
        <>
          <section className="host-join-panel" aria-labelledby="lobby-title">
            <div>
              <p className="arcade-eyebrow text-neon-cyan">YOUR PHONE IS YOUR CONTROLLER</p>
              <h1 id="lobby-title">Gather the crew.</h1>
              <p className="lobby-description">Scan to join, or enter this room code on your phone.</p>
              <p className="room-code" aria-label={`Room code ${room.code}`}>{room.code}</p>
            </div>
            <RoomQRCode code={room.code} />
          </section>
          <section className="host-roster" aria-labelledby="players-title">
            <div className="roster-heading">
              <h2 id="players-title">THE LINEUP <span aria-label="Player count">{room.players.length} / {room.maxPlayers}</span></h2>
              <p aria-live="polite">{!room.canStart && missingPlayers > 0 ? `Need ${missingPlayers} more players` : room.canStart ? 'The crew is ready' : 'Waiting for the host screen'}</p>
            </div>
            <ul className="player-grid">
              {room.players.map((player) => <PlayerCard key={player.id} player={player} />)}
              {Array.from({ length: Math.max(0, room.maxPlayers - room.players.length) }, (_, index) => (
                <li className="player-empty" key={`empty-${index}`}><span aria-hidden="true">+</span> Waiting for a rival</li>
              ))}
            </ul>
          </section>
          <footer className="host-footer">
            <p>One screen. Your phones. Total chaos.</p>
            <div className="host-start">
              <button type="button" className="arcade-button start-button" onClick={lobby.start} disabled={!room.canStart || !connected || status !== 'lobby' || starting || startAccepted}>
                {restoring ? 'RECONNECTING…' : starting ? 'STARTING…' : startAccepted ? 'START REQUESTED' : 'START'} <span aria-hidden="true">→</span>
              </button>
              <p aria-live="polite">{startAccepted ? 'Waiting for the game screen.' : !room.canStart && missingPlayers > 0 ? `Need ${missingPlayers} more players` : 'Everyone in? Let’s do this.'}</p>
            </div>
          </footer>
        </>
      ) : (
        <section className="lobby-state" aria-live="polite" aria-busy={status === 'creating' || restoring}>
          <span className="lobby-orbit" aria-hidden="true">✳</span>
          <p className="arcade-eyebrow">SET THE STAGE</p>
          <h1>{status === 'closed' ? 'Room closed' : status === 'error' ? 'Could not open room' : status === 'timeout' ? 'Still waiting for the server…' : restoring ? 'Restoring your lobby…' : 'Creating room…'}</h1>
          <p className="lobby-description">{restoring ? 'Bringing back your room code and your crew.' : status === 'creating' ? 'Getting a room code ready for your crew.' : 'Your next RUMBLE is one lobby away.'}</p>
          {status !== 'creating' && !restoring && <a className="arcade-button" href="/host">{status === 'closed' ? 'Create a new lobby' : 'Try again'} <span aria-hidden="true">→</span></a>}
        </section>
      )}
    </main>
  );
}
