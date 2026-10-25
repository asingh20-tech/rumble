import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mountPhaserGame } from './gameRuntime.js';

function factory() {
  let created = 0, active = 0, maxActive = 0, destroyed = 0;
  return {
    create() {
      created++; active++; maxActive = Math.max(maxActive, active);
      const events = new EventEmitter();
      return { events, canvas: { remove() {} }, destroy(removeCanvas) {
        assert.equal(removeCanvas, true);
        queueMicrotask(() => { destroyed++; active--; events.emit('destroy'); });
      } };
    },
    counts: () => ({ created, active, maxActive, destroyed }),
  };
}

test('StrictMode cleanup cancels initial mount before constructing a Game', async () => {
  const f = factory();
  const first = mountPhaserGame(() => f.create());
  const stopped = first.dispose();
  const second = mountPhaserGame(() => f.create());
  assert.equal(await first.ready, null); await stopped; await second.ready;
  assert.deepEqual(f.counts(), { created: 1, active: 1, maxActive: 1, destroyed: 0 });
  await second.dispose(); assert.equal(f.counts().active, 0);
});

test('waits for asynchronous Phaser destruction before creating a replacement', async () => {
  const f = factory(); const first = mountPhaserGame(() => f.create()); await first.ready;
  const stopped = first.dispose();
  const replacement = mountPhaserGame(() => f.create());
  await stopped; await replacement.ready;
  assert.equal(f.counts().maxActive, 1); assert.equal(f.counts().destroyed, 1);
  await replacement.dispose();
});

test('cancels a pending asynchronous mount and destroys any late-created Game', async () => {
  const f = factory(); let proceed;
  const waiting = new Promise((resolve) => { proceed = resolve; });
  const first = mountPhaserGame(async () => { await waiting; return f.create(); });
  await Promise.resolve();
  const stopped = first.dispose(); const second = mountPhaserGame(() => f.create());
  proceed(); assert.equal(await first.ready, null); await stopped; await second.ready;
  assert.equal(f.counts().maxActive, 1); assert.equal(f.counts().destroyed, 1);
  await second.dispose();
});

test('repeated cleanup destroys once and a failed constructor does not poison later mounts', async () => {
  const f = factory(); const bad = mountPhaserGame(() => { throw Error('test failure'); });
  await assert.rejects(bad.ready, /test failure/); await bad.dispose();
  const good = mountPhaserGame(() => f.create()); await good.ready;
  await Promise.all([good.dispose(), good.dispose()]);
  assert.equal(f.counts().destroyed, 1);
});
