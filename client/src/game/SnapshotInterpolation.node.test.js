import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TICK_MS } from '@rumble/shared/constants';
import SnapshotInterpolation, { MAX_BUFFERED_SNAPSHOTS } from './SnapshotInterpolation.js';

const player = (id, x, extra = {}) => ({ id, x, y: 200, alive: true, connected: true, ...extra });
const frame = (tick, serverTime, players) => ({ tick, serverTime, players, timeLeftMs: 50000, events: [] });
function moving() {
  const buffer = new SnapshotInterpolation();
  for (let index = 0; index <= 6; index++) buffer.push(frame(index, 1000 + index * TICK_MS, [player('a', index * 10)]), index * TICK_MS);
  return buffer;
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} should equal ${expected}`);

test('renders 100 ms behind server time and interpolates between 30 Hz updates at 60 FPS', () => {
  const buffer = moving();
  close(buffer.sample(200)[0].x, 30);
  close(buffer.sample(200 + TICK_MS / 2)[0].x, 35);
  close(buffer.sample(200 + TICK_MS)[0].x, 40);
});

test('works when server and local clocks have different origins', () => {
  const buffer = new SnapshotInterpolation();
  const epoch = 1_700_000_000_000;
  buffer.push(frame(0, epoch, [player('a', 0)]), 100);
  buffer.push(frame(1, epoch + 100, [player('a', 100)]), 200);
  close(buffer.sample(250)[0].x, 50);
});

test('freezes at the last authoritative position instead of extrapolating through packet loss', () => {
  const buffer = moving();
  close(buffer.sample(900)[0].x, 60);
  close(buffer.sample(1500)[0].x, 60);
});

test('late packets and duplicate/out-of-order ticks cannot rewind a player', () => {
  const buffer = moving();
  const first = buffer.sample(220)[0].x;
  assert.equal(buffer.push(frame(5, 1000 + 7 * TICK_MS, [player('a', -100)]), 240), false);
  assert.equal(buffer.push(frame(7, 1100, [player('a', -100)]), 240), false);
  buffer.push(frame(7, 1000 + 7 * TICK_MS, [player('a', 70)]), 260);
  assert.ok(buffer.sample(260)[0].x >= first);
  assert.ok(buffer.sample(240)[0].x >= first);
});

test('uses IDs when player ordering changes', () => {
  const buffer = new SnapshotInterpolation();
  buffer.push(frame(1, 1000, [player('a', 0), player('b', 100)]), 0);
  buffer.push(frame(2, 1100, [player('b', 200), player('a', 100)]), 100);
  const players = new Map(buffer.sample(150).map((p) => [p.id, p.x]));
  close(players.get('a'), 50); close(players.get('b'), 150);
});

test('spawns and removes players at their server timestamps without lerping from the origin', () => {
  const buffer = new SnapshotInterpolation();
  buffer.push(frame(1, 1000, [player('a', 50)]), 0);
  buffer.push(frame(2, 1100, [player('a', 60), player('b', 400)]), 100);
  buffer.push(frame(3, 1200, [player('b', 420)]), 200);
  assert.deepEqual(buffer.sample(150).map((p) => p.id), ['a']);
  assert.deepEqual(buffer.sample(200).map((p) => p.id), ['a', 'b']);
  assert.deepEqual(buffer.sample(300).map((p) => p.id), ['b']);
});

test('applies connected/alive changes at the displayed snapshot, not early', () => {
  const buffer = new SnapshotInterpolation();
  buffer.push(frame(1, 1000, [player('a', 0)]), 0);
  buffer.push(frame(2, 1100, [player('a', 10, { connected: false, alive: false })]), 100);
  assert.equal(buffer.sample(150)[0].connected, true);
  assert.equal(buffer.sample(200)[0].connected, false);
  assert.equal(buffer.sample(200)[0].alive, false);
});

test('does not mutate input or expose mutable buffer entries through samples', () => {
  const input = Object.freeze(frame(1, 1000, Object.freeze([Object.freeze(player('a', 10))])));
  const buffer = new SnapshotInterpolation(); buffer.push(input, 0);
  const sampled = buffer.sample(100); sampled[0].x = 999;
  assert.equal(input.players[0].x, 10);
  assert.equal(buffer.sample(100)[0].x, 10);
});

test('bounds history and resets it after a long connection gap or a new round', () => {
  const buffer = moving();
  for (let i = 7; i < 100; i++) buffer.push(frame(i, 1000 + i * TICK_MS, [player('a', i)]), i * TICK_MS);
  assert.ok(buffer.frames.length <= MAX_BUFFERED_SNAPSHOTS);
  buffer.push(frame(100, 10000, [player('b', 500)]), 9000);
  assert.deepEqual(buffer.sample(9000).map((p) => p.id), ['b']);
  buffer.reset(); assert.equal(buffer.sample(9001), null);
  assert.equal(buffer.push(frame(0, 11000, [player('c', 100)]), 10000), true);
});

test('ignores malformed snapshots and players with invalid coordinates', () => {
  const buffer = new SnapshotInterpolation();
  assert.equal(buffer.push({ tick: 1, serverTime: NaN, players: [] }, 0), false);
  assert.equal(buffer.push({ tick: -1, serverTime: 1000, players: [] }, 0), false);
  assert.equal(buffer.sample(0), null);
  buffer.push(frame(1, 1000, [player('a', NaN), player('b', 20)]), 0);
  assert.deepEqual(buffer.sample(100).map((p) => p.id), ['b']);
});
