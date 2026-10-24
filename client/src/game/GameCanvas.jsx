import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ARENA, THEME } from '@rumble/shared/constants';

/** Rendering only. Supply renderer snapshots via the snapshot prop or ref.setState(). */
const GameCanvas = forwardRef(function GameCanvas({ snapshot, className = '' }, ref) {
  const parentRef = useRef(null);
  const gameRef = useRef(null);
  const sceneRef = useRef(null);
  const latestSnapshot = useRef(snapshot);
  const [status, setStatus] = useState('loading');

  useImperativeHandle(ref, () => ({
    setState(nextSnapshot) {
      latestSnapshot.current = nextSnapshot;
      sceneRef.current?.setState(nextSnapshot);
    },
  }), []);

  useEffect(() => {
    latestSnapshot.current = snapshot;
    if (snapshot) sceneRef.current?.setState(snapshot);
  }, [snapshot]);

  useEffect(() => {
    let cancelled = false;
    let ownedGame = null;
    async function mount() {
      // Awaiting imports lets StrictMode finish its effect replay before creating
      // a Game. The cancelled flag and ref guard prevent overlapping instances.
      const [{ default: Phaser }, { default: ArenaScene }] = await Promise.all([
        import('phaser'), import('./ArenaScene.js'),
      ]);
      if (cancelled || gameRef.current || !parentRef.current) return;
      const scene = new ArenaScene({
        reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        onReady: () => { if (!cancelled) setStatus('ready'); },
      });
      sceneRef.current = scene;
      scene.setState(latestSnapshot.current ?? { players: [] });
      ownedGame = new Phaser.Game({
        type: Phaser.AUTO,
        parent: parentRef.current,
        width: ARENA.width,
        height: ARENA.height,
        backgroundColor: THEME.background,
        scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
        render: { antialias: true },
        audio: { noAudio: true },
        scene: [scene],
      });
      gameRef.current = ownedGame;
    }
    mount().catch(() => { if (!cancelled) setStatus('error'); });
    return () => {
      cancelled = true;
      if (ownedGame && gameRef.current === ownedGame) {
        gameRef.current = null;
        sceneRef.current = null;
        ownedGame.destroy(true);
      }
    };
  }, []);

  return (
    <div className={`game-canvas-shell ${className}`} style={{ aspectRatio: `${ARENA.width} / ${ARENA.height}` }} role="img" aria-label="RUMBLE arena with colored players on a neon circular platform">
      <div className="game-canvas-parent" ref={parentRef} />
      {status !== 'ready' && <p className="game-canvas-status" role="status">{status === 'error' ? 'The arena could not load. Refresh to try again.' : 'Powering up the arena…'}</p>}
    </div>
  );
});
export default GameCanvas;
