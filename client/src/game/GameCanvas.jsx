import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ARENA, THEME } from '@rumble/shared/constants';
import { MAX_BUFFERED_SNAPSHOTS } from './SnapshotInterpolation.js';
import { mountPhaserGame } from './gameRuntime.js';

/** Receives snapshots imperatively; React renders only loading/error UI. */
const GameCanvas = forwardRef(function GameCanvas({ className = '' }, ref) {
  const parentRef = useRef(null);
  const gameRef = useRef(null);
  const sceneRef = useRef(null);
  const pendingFrames = useRef([]);
  const [status, setStatus] = useState('loading');

  useImperativeHandle(ref, () => ({
    setState(snapshot, receivedAt = performance.now()) {
      const last = pendingFrames.current.at(-1);
      if (last?.snapshot.tick === snapshot.tick) {
        pendingFrames.current[pendingFrames.current.length - 1] = { snapshot, receivedAt: last.receivedAt };
      } else if (!last || snapshot.serverTime > last.snapshot.serverTime) {
        pendingFrames.current.push({ snapshot, receivedAt });
        pendingFrames.current = pendingFrames.current.slice(-MAX_BUFFERED_SNAPSHOTS);
      }
      sceneRef.current?.setState(snapshot, receivedAt);
    },
    reset() {
      pendingFrames.current = [];
      sceneRef.current?.reset();
    },
  }), []);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    const mounting = mountPhaserGame(async (isCancelled) => {
      const [{ default: Phaser }, { default: ArenaScene }] = await Promise.all([
        import('phaser'), import('./ArenaScene.js'),
      ]);
      if (isCancelled() || cancelled || gameRef.current || !parentRef.current) return null;
      const scene = new ArenaScene({
        reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        onReady: () => { if (!cancelled) setStatus('ready'); },
      });
      sceneRef.current = scene;
      for (const { snapshot, receivedAt } of pendingFrames.current) scene.setState(snapshot, receivedAt);
      const game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: parentRef.current,
        width: ARENA.width,
        height: ARENA.height,
        backgroundColor: THEME.background,
        scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
        render: { antialias: true },
        fps: { target: 60, limit: 60 },
        audio: { noAudio: true },
        scene: [scene],
      });
      gameRef.current = game;
      return game;
    });
    mounting.ready.catch(() => { if (!cancelled) setStatus('error'); });
    return () => {
      cancelled = true;
      gameRef.current = null;
      sceneRef.current = null;
      void mounting.dispose();
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
