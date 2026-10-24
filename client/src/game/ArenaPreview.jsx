import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Pause, Play, RotateCcw } from 'lucide-react';
import { ARENA, PLAYER_COLORS } from '@rumble/shared/constants';
import GameCanvas from './GameCanvas.jsx';

const samplePlayers = ['NOVA', 'PIXEL', 'BLAZE', 'GHOST'].map((name, index) => ({ id: `preview-${index}`, name, colorIndex: index, alive: true, connected: true }));
export function previewSnapshot(elapsed = 0) {
  return { players: samplePlayers.map((player, index) => {
    const angle = elapsed * (index % 2 ? -0.21 : 0.24) + index * Math.PI / 2;
    const radius = ARENA.platformRadius * (0.47 + Math.sin(elapsed * 0.45 + index) * 0.14);
    return { ...player, x: ARENA.centerX + Math.cos(angle) * radius, y: ARENA.centerY + Math.sin(angle) * radius * 0.85 };
  }) };
}
const initialSnapshot = previewSnapshot();

export default function ArenaPreview() {
  const canvas = useRef(null);
  const elapsed = useRef(0);
  const [running, setRunning] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (!running) return;
    let frame;
    let previous;
    function animate(now) {
      if (previous !== undefined) elapsed.current += Math.min(now - previous, 100) / 1000;
      previous = now;
      canvas.current?.setState(previewSnapshot(elapsed.current));
      frame = requestAnimationFrame(animate);
    }
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [running]);
  function reset() {
    elapsed.current = 0;
    canvas.current?.setState(initialSnapshot);
  }
  return (
    <main className="arcade-page arena-preview-page">
      <header className="arena-preview-header"><Link to="/" className="arena-back"><ArrowLeft size={18} aria-hidden="true" /> Back to RUMBLE</Link><span className="arena-preview-badge">DEV PREVIEW</span></header>
      <section className="arena-preview-intro"><p className="arcade-eyebrow text-neon-cyan">THE STAGE IS SET</p><h1>Welcome to the arena.</h1><p>A little space. A lot of rivalry.</p></section>
      <GameCanvas ref={canvas} snapshot={initialSnapshot} />
      <div className="arena-preview-toolbar"><div className="arena-preview-legend">{samplePlayers.map((player) => <span key={player.id} style={{ '--player-color': PLAYER_COLORS[player.colorIndex].hex }}><i />{player.name}</span>)}</div>
        <div className="arena-preview-controls"><button type="button" onClick={() => setRunning((value) => !value)}>{running ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}{running ? 'Pause players' : 'Resume players'}</button><button type="button" onClick={reset}><RotateCcw size={16} aria-hidden="true" /> Reset</button></div></div>
      <p className="arena-preview-footnote">{ARENA.width} × {ARENA.height} · Visual preview only. Player positions are animated locally.</p>
    </main>
  );
}
