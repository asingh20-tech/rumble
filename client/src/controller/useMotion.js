import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MOTION_DEFAULTS,
  SENSITIVITY_DEFAULT,
  accelerationMagnitude,
  averageOrientation,
  clampSensitivity,
  createHighPassFilter,
  shakeDamping,
  smoothVector,
  tiltFromOrientation,
} from './motionMath.js';

const SENSITIVITY_KEY = 'rumble:sensitivity';
const CALIBRATION_MS = 500;
/** If no real orientation reading arrives this long after enabling, the device has no sensor. */
const NO_SENSOR_TIMEOUT_MS = 2000;
const ZERO = Object.freeze({ x: 0, y: 0 });

/** @typedef {'idle'|'granted'|'denied'|'unsupported'|'insecure'} MotionStatus */

function detectSupport() {
  if (typeof window === 'undefined') return { orientation: false, motion: false, secure: false };
  return {
    orientation: 'DeviceOrientationEvent' in window,
    motion: 'DeviceMotionEvent' in window,
    secure: window.isSecureContext !== false,
  };
}

/** @returns {MotionStatus} */
function initialStatus(support) {
  if (!support.secure) return 'insecure';
  if (!support.orientation) return 'unsupported';
  return 'idle';
}

function loadSensitivity() {
  try {
    const raw = window.localStorage.getItem(SENSITIVITY_KEY);
    return raw == null ? SENSITIVITY_DEFAULT : clampSensitivity(raw);
  } catch {
    return SENSITIVITY_DEFAULT;
  }
}

function saveSensitivity(value) {
  try {
    window.localStorage.setItem(SENSITIVITY_KEY, String(value));
  } catch {
    // Storage unavailable: the setting just won't survive a reload.
  }
}

/**
 * Tilt + shake input from iPhone motion sensors.
 *
 * enable() MUST be called directly from a tap handler: on iOS 13+ it calls
 * DeviceOrientationEvent.requestPermission() and DeviceMotionEvent.requestPermission() in
 * that same handler. Permission does not survive a reload, so status starts at 'idle' again.
 *
 * Tilt is read with getTilt() (a stable function returning the latest smoothed {x, y}) so
 * that 60 Hz sensor events don't re-render React.
 *
 * @param {{ onShake?: () => void } & Partial<typeof MOTION_DEFAULTS>} [options]
 */
export function useMotion({ onShake, ...overrides } = {}) {
  const [support] = useState(detectSupport);
  const [status, setStatus] = useState(() => initialStatus(support));
  const [calibrated, setCalibrated] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [sensitivity, setSensitivityState] = useState(loadSensitivity);

  const optionsRef = useRef(null);
  optionsRef.current = { ...MOTION_DEFAULTS, ...overrides, sensitivity };
  const onShakeRef = useRef(onShake);
  useEffect(() => {
    onShakeRef.current = onShake;
  });

  // Mutable sensor state, kept out of React state on purpose.
  const [sensor] = useState(() => ({
    neutral: { beta: 0, gamma: 0 },
    smoothed: { x: 0, y: 0 },
    tilt: ZERO,
    lastSpikeAt: Number.NEGATIVE_INFINITY,
    lastShakeAt: Number.NEGATIVE_INFINITY,
    samples: null,
    hasReading: false,
    detach: null,
    calibrationTimer: null,
    calibrationDone: null,
  }));

  const detach = useCallback(() => {
    sensor.detach?.();
    sensor.detach = null;
    clearTimeout(sensor.calibrationTimer);
    sensor.calibrationTimer = null;
    sensor.samples = null;
    sensor.calibrationDone?.(false);
    sensor.calibrationDone = null;
    sensor.smoothed = { x: 0, y: 0 };
    sensor.tilt = ZERO;
    setCalibrating(false);
  }, [sensor]);

  const attach = useCallback(() => {
    if (sensor.detach) return;
    const highPass = createHighPassFilter();
    sensor.hasReading = false;

    const onOrientation = (event) => {
      if (event.beta == null || event.gamma == null) return;
      sensor.hasReading = true;
      const reading = { beta: event.beta, gamma: event.gamma };
      sensor.samples?.push(reading);
      const options = optionsRef.current;
      const target = tiltFromOrientation(reading, sensor.neutral, options);
      sensor.smoothed = smoothVector(sensor.smoothed, target, options.smoothing);
      const damp = shakeDamping(performance.now(), sensor.lastSpikeAt, options.shakeDampMs);
      sensor.tilt = { x: sensor.smoothed.x * damp, y: sensor.smoothed.y * damp };
    };

    const onMotion = (event) => {
      let linear = event.acceleration;
      if (linear?.x == null) {
        const withGravity = event.accelerationIncludingGravity;
        if (withGravity?.x == null) return;
        linear = highPass(withGravity);
      }
      const options = optionsRef.current;
      if (accelerationMagnitude(linear) <= options.shakeThreshold) return;
      const now = performance.now();
      sensor.lastSpikeAt = now;
      if (now - sensor.lastShakeAt < options.shakeCooldownMs) return;
      sensor.lastShakeAt = now;
      onShakeRef.current?.();
    };

    window.addEventListener('deviceorientation', onOrientation);
    window.addEventListener('devicemotion', onMotion);
    // Desktop browsers expose the API but never deliver readings: fall back to touch.
    const watchdog = setTimeout(() => {
      if (sensor.hasReading) return;
      detach();
      setStatus('unsupported');
    }, NO_SENSOR_TIMEOUT_MS);

    sensor.detach = () => {
      clearTimeout(watchdog);
      window.removeEventListener('deviceorientation', onOrientation);
      window.removeEventListener('devicemotion', onMotion);
    };
  }, [sensor, detach]);

  /**
   * Ask for sensor access and start listening. Call from a tap handler only.
   * @returns {Promise<MotionStatus>}
   */
  const enable = useCallback(() => {
    const current = initialStatus(support);
    if (current !== 'idle') {
      setStatus(current);
      return Promise.resolve(current);
    }
    // Both requests are issued synchronously, inside the same user gesture.
    let requests;
    try {
      const Orientation = window.DeviceOrientationEvent;
      const Motion = window.DeviceMotionEvent;
      requests = [
        typeof Orientation?.requestPermission === 'function'
          ? Orientation.requestPermission()
          : 'granted',
        typeof Motion?.requestPermission === 'function' ? Motion.requestPermission() : 'granted',
      ];
    } catch {
      setStatus('denied');
      return Promise.resolve('denied');
    }
    return Promise.all(requests).then(
      ([orientation]) => {
        // Orientation is required for movement; shake simply won't fire without motion.
        if (orientation !== 'granted') {
          setStatus('denied');
          return 'denied';
        }
        attach();
        setStatus('granted');
        return 'granted';
      },
      () => {
        setStatus('denied');
        return 'denied';
      },
    );
  }, [support, attach]);

  /** Stop listening (e.g. switching to touch mode). Permission stays granted until reload. */
  const disable = useCallback(() => {
    detach();
    setStatus((s) => (s === 'granted' ? 'idle' : s));
  }, [detach]);

  /**
   * Average ~0.5s of readings and use them as the neutral position.
   * @returns {Promise<boolean>} false if no readings arrived (sensor off or not enabled)
   */
  const calibrate = useCallback(
    () =>
      new Promise((resolve) => {
        if (!sensor.detach) {
          resolve(false);
          return;
        }
        clearTimeout(sensor.calibrationTimer);
        sensor.calibrationDone?.(false);
        sensor.samples = [];
        sensor.calibrationDone = resolve;
        setCalibrating(true);
        sensor.calibrationTimer = setTimeout(() => {
          const neutral = averageOrientation(sensor.samples);
          sensor.samples = null;
          sensor.calibrationTimer = null;
          sensor.calibrationDone = null;
          setCalibrating(false);
          if (!neutral) {
            resolve(false);
            return;
          }
          sensor.neutral = neutral;
          sensor.smoothed = { x: 0, y: 0 };
          sensor.tilt = ZERO;
          setCalibrated(true);
          resolve(true);
        }, CALIBRATION_MS);
      }),
    [sensor],
  );

  const setSensitivity = useCallback((value) => {
    const next = clampSensitivity(value);
    setSensitivityState(next);
    saveSensitivity(next);
  }, []);

  const getTilt = useCallback(() => sensor.tilt, [sensor]);

  useEffect(() => detach, [detach]);

  return {
    status,
    support,
    calibrated,
    calibrating,
    sensitivity,
    enable,
    disable,
    calibrate,
    setSensitivity,
    getTilt,
  };
}
