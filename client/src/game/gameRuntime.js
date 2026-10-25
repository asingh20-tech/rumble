// Preserve the serialization queue when Vite replaces this module during HMR.
const runtime = import.meta.hot?.data.phaserRuntime ?? { queue: Promise.resolve(), game: null };
if (import.meta.hot) import.meta.hot.data.phaserRuntime = runtime;

function enqueue(task) {
  const result = runtime.queue.then(task);
  runtime.queue = result.catch(() => {});
  return result;
}
function destroy(game) {
  return new Promise((resolve) => {
    // Phaser destroy() completes on its next frame. Do not create a replacement
    // until DESTROY has fired and the current synchronous teardown has finished.
    game.events.once('destroy', resolve);
    game.canvas?.remove();
    game.destroy(true);
  });
}

/** Serialize mount/teardown across StrictMode, remounts, and hot refresh. */
export function mountPhaserGame(create) {
  let cancelled = false;
  let ownedGame = null;
  async function release() {
    if (!ownedGame) return;
    const game = ownedGame;
    ownedGame = null;
    await destroy(game);
    if (runtime.game === game) runtime.game = null;
  }
  const ready = enqueue(async () => {
    if (cancelled) return null;
    if (runtime.game) throw new Error('An arena is already mounted.');
    const game = await create(() => cancelled);
    if (!game) return null;
    ownedGame = game;
    runtime.game = game;
    if (cancelled) { await release(); return null; }
    return game;
  });
  return {
    ready,
    dispose() { cancelled = true; return enqueue(release); },
  };
}
