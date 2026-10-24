// Pure math for turning iPhone sensor readings into game input. No DOM access, so it can be
// reasoned about (and tested) without a device.

export const MOTION_DEFAULTS = Object.freeze({
  /** Tilt (degrees from the calibrated neutral) that is ignored as hand jitter. */
  deadZoneDeg: 3,
  /** Tilt (degrees) that maps to full speed at 1x sensitivity. */
  maxTiltDeg: 25,
  /** Low-pass factor per sensor event: 0 = frozen, 1 = no smoothing. */
  smoothing: 0.25,
  /** Linear acceleration (m/s^2, gravity removed) that counts as a shake. */
  shakeThreshold: 18,
  /** Minimum time between two reported shakes. */
  shakeCooldownMs: 400,
  /** After a shake spike, tilt output ramps back from 0 over this long. */
  shakeDampMs: 250,
});

export const SENSITIVITY_MIN = 0.5;
export const SENSITIVITY_MAX = 2;
export const SENSITIVITY_DEFAULT = 1;

/** @param {unknown} value */
export function clampSensitivity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return SENSITIVITY_DEFAULT;
  return Math.min(SENSITIVITY_MAX, Math.max(SENSITIVITY_MIN, n));
}

/**
 * Clamp each axis to [-1, 1], then scale the vector so its length is at most 1.
 * Mirrors the server's validation so what we display is what the server stores.
 * @param {number} x
 * @param {number} y
 */
export function clampVector(x, y) {
  let cx = Math.min(1, Math.max(-1, x));
  let cy = Math.min(1, Math.max(-1, y));
  const length = Math.hypot(cx, cy);
  if (length > 1) {
    cx /= length;
    cy /= length;
  }
  return { x: cx, y: cy };
}

/**
 * Map a portrait-orientation reading to a movement vector.
 * gamma (left/right roll) drives x; beta (front/back pitch) drives y. Tilting the top edge
 * away from you lowers beta, which gives negative y = up on screen. A radial dead zone
 * removes jitter around neutral without making diagonals sticky.
 * @param {{ beta: number, gamma: number }} reading degrees
 * @param {{ beta: number, gamma: number }} neutral calibration offsets
 * @param {{ deadZoneDeg: number, maxTiltDeg: number, sensitivity: number }} options
 * @returns {{ x: number, y: number }}
 */
export function tiltFromOrientation(reading, neutral, { deadZoneDeg, maxTiltDeg, sensitivity }) {
  const dx = reading.gamma - neutral.gamma;
  const dy = reading.beta - neutral.beta;
  const magnitude = Math.hypot(dx, dy);
  if (magnitude <= deadZoneDeg) return { x: 0, y: 0 };
  const range = Math.max(1, maxTiltDeg - deadZoneDeg);
  const scale = (((magnitude - deadZoneDeg) / range) * sensitivity) / magnitude;
  return clampVector(dx * scale, dy * scale);
}

/**
 * One step of an exponential low-pass filter.
 * @param {{ x: number, y: number }} previous
 * @param {{ x: number, y: number }} target
 * @param {number} alpha 0..1
 */
export function smoothVector(previous, target, alpha) {
  return {
    x: previous.x + alpha * (target.x - previous.x),
    y: previous.y + alpha * (target.y - previous.y),
  };
}

/**
 * Tilt multiplier after a shake spike: 0 right at the spike, ramping linearly back to 1
 * over `dampMs`, so the shake itself doesn't fling the character.
 * @param {number} now
 * @param {number} lastSpikeAt
 * @param {number} dampMs
 */
export function shakeDamping(now, lastSpikeAt, dampMs) {
  const elapsed = now - lastSpikeAt;
  if (!(elapsed < dampMs)) return 1;
  return Math.max(0, elapsed / dampMs);
}

/** @param {{ x?: number|null, y?: number|null, z?: number|null }} a */
export function accelerationMagnitude(a) {
  return Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0);
}

/**
 * High-pass filter for accelerationIncludingGravity: tracks gravity with a low-pass filter
 * and returns what's left (the linear acceleration). Seeds gravity from the first sample so
 * the first reading isn't mistaken for a 9.8 m/s^2 spike.
 * @param {number} [gravityAlpha] weight kept from the previous gravity estimate
 */
export function createHighPassFilter(gravityAlpha = 0.8) {
  let gravity = null;
  return (sample) => {
    const x = sample.x ?? 0;
    const y = sample.y ?? 0;
    const z = sample.z ?? 0;
    if (!gravity) gravity = { x, y, z };
    gravity = {
      x: gravityAlpha * gravity.x + (1 - gravityAlpha) * x,
      y: gravityAlpha * gravity.y + (1 - gravityAlpha) * y,
      z: gravityAlpha * gravity.z + (1 - gravityAlpha) * z,
    };
    return { x: x - gravity.x, y: y - gravity.y, z: z - gravity.z };
  };
}

/**
 * Average orientation readings into a neutral position. Returns null if there are none.
 * @param {{ beta: number, gamma: number }[]} samples
 */
export function averageOrientation(samples) {
  if (!samples || samples.length === 0) return null;
  let beta = 0;
  let gamma = 0;
  for (const s of samples) {
    beta += s.beta;
    gamma += s.gamma;
  }
  return { beta: beta / samples.length, gamma: gamma / samples.length };
}
