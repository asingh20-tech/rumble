import { TICK_MS } from '@rumble/shared/constants';

export const INTERPOLATION_DELAY_MS = 100;
// Three tick intervals of delay need an older bracket plus future samples.
export const MAX_BUFFERED_SNAPSHOTS = Math.ceil(INTERPOLATION_DELAY_MS / TICK_MS) + 2;
const RESET_GAP_MS = 1000;

/** Timestamp interpolation only: no prediction, simulation, or network I/O. */
export default class SnapshotInterpolation {
  constructor() { this.reset(); }

  reset() {
    this.frames = [];
    this.clockOffset = null;
    this.renderTime = null;
  }

  push(snapshot, receivedAt) {
    if (!Number.isFinite(snapshot?.serverTime) || !Number.isInteger(snapshot.tick) ||
        snapshot.tick < 0 || !Array.isArray(snapshot.players) || !Number.isFinite(receivedAt)) return false;
    const previous = this.frames.at(-1);
    if (previous && (snapshot.tick <= previous.tick || snapshot.serverTime <= previous.serverTime)) return false;
    if (previous && snapshot.serverTime - previous.serverTime > RESET_GAP_MS) this.reset();
    // The best observed offset approximates the server clock without depending
    // on the laptop's wall clock. Late packets cannot make render time go back.
    const offset = snapshot.serverTime - receivedAt;
    this.clockOffset = this.clockOffset === null ? offset : Math.max(this.clockOffset, offset);
    this.frames.push({
      tick: snapshot.tick,
      serverTime: snapshot.serverTime,
      players: snapshot.players.filter((player) => typeof player.id === 'string' && Number.isFinite(player.x) && Number.isFinite(player.y)).map((player) => ({ ...player })),
    });
    this.frames = this.frames.slice(-MAX_BUFFERED_SNAPSHOTS);
    return true;
  }

  sample(now) {
    if (!this.frames.length || !Number.isFinite(now)) return null;
    const oldest = this.frames[0];
    const latest = this.frames.at(-1);
    const target = now + this.clockOffset - INTERPOLATION_DELAY_MS;
    this.renderTime = Math.max(this.renderTime ?? oldest.serverTime,
      Math.min(latest.serverTime, Math.max(oldest.serverTime, target)));
    // Keep the older endpoint until its successor is actually displayed.
    while (this.frames.length > 2 && this.frames[1].serverTime <= this.renderTime) this.frames.shift();
    const before = this.frames[0];
    const after = this.frames[1];
    if (!after || this.renderTime >= latest.serverTime) return latest.players.map((player) => ({ ...player }));
    const fraction = Math.min(1, Math.max(0, (this.renderTime - before.serverTime) / (after.serverTime - before.serverTime)));
    if (fraction >= 1) return after.players.map((player) => ({ ...player }));
    const nextPlayers = new Map(after.players.map((player) => [player.id, player]));
    // Membership/connected/alive changes take effect at their snapshot timestamp,
    // so newcomers do not lerp from the origin and vanished players do not linger.
    return before.players.map((player) => {
      const next = nextPlayers.get(player.id);
      return next ? { ...player, x: player.x + (next.x - player.x) * fraction, y: player.y + (next.y - player.y) * fraction } : { ...player };
    });
  }
}
