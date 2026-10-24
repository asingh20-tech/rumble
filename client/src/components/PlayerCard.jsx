import { PLAYER_COLORS } from '@rumble/shared/constants';

export default function PlayerCard({ player }) {
  const color = PLAYER_COLORS[player.colorIndex];
  return (
    <li className={`player-card${player.connected ? '' : ' player-card-away'}`} style={{ '--player-color': color.hex }}>
      <span className="player-avatar" aria-hidden="true">{player.name.slice(0, 1).toUpperCase()}</span>
      <div className="player-details">
        <h3 title={player.name}>{player.name}</h3>
        <p className="player-status"><span aria-hidden="true">{player.connected ? '●' : '○'}</span> {player.connected ? 'Connected' : 'Disconnected'}</p>
      </div>
    </li>
  );
}
