// Throttling for player:input. Pure (no socket, no timers) so the rules are easy to check:
// - never more often than INPUT_MIN_GAP_MS (keeps us under the server's 30/s limit),
// - send as soon as the value changes, otherwise a heartbeat every INPUT_HEARTBEAT_MS so the
//   server's copy never goes stale while the phone is held still.

import { INPUT_RATE_LIMIT_PER_SEC } from '@rumble/shared/constants';

/** Slightly over 1000/30 ms so timer jitter can't push us past the server limit. */
export const INPUT_MIN_GAP_MS = Math.ceil(1000 / INPUT_RATE_LIMIT_PER_SEC) + 1;
export const INPUT_HEARTBEAT_MS = 100;
/** How often the page polls the current input and offers it to the sender. */
export const INPUT_POLL_MS = INPUT_MIN_GAP_MS + 1;

/** Two decimals is plenty for movement and keeps "changed" from firing on sensor noise. */
const quantize = (v) => Math.round(v * 100) / 100 || 0;

/**
 * @param {{ send: (payload: { x: number, y: number, seq: number }) => void,
 *           now?: () => number }} options
 */
export function createInputSender({ send, now = () => performance.now() }) {
  let seq = 0;
  let last = null;
  let lastSentAt = Number.NEGATIVE_INFINITY;

  return {
    /**
     * Offer the current input. Sends it if the throttle allows.
     * @returns {boolean} true if a message was sent
     */
    update(x, y) {
      const t = now();
      const elapsed = t - lastSentAt;
      if (elapsed < INPUT_MIN_GAP_MS) return false;
      const qx = quantize(x);
      const qy = quantize(y);
      const changed = !last || qx !== last.x || qy !== last.y;
      if (!changed && elapsed < INPUT_HEARTBEAT_MS) return false;
      last = { x: qx, y: qy };
      lastSentAt = t;
      send({ x: qx, y: qy, seq });
      seq += 1;
      return true;
    },

    /** Forget the last sent value (after a reconnect) so the next update sends at once. seq keeps counting. */
    reset() {
      last = null;
      lastSentAt = Number.NEGATIVE_INFINITY;
    },
  };
}
