import { useCallback, useEffect, useRef, useState } from 'react';
import { useMotion } from './useMotion.js';
import { MOTION_DEFAULTS, clampVector } from './motionMath.js';

const ZERO = Object.freeze({ x: 0, y: 0 });

/** Why touch mode is on, for the TOUCH MODE label. */
const TOUCH_REASONS = {
  chosen: 'You picked touch controls.',
  denied: 'Motion access was denied.',
  unsupported: 'This device has no motion sensors.',
  insecure: 'Motion sensors need an https:// link.',
};

/**
 * One input source for the controller: motion sensors when available and calibrated,
 * otherwise the on-screen joystick + SHAKE button ("touch mode"). Lives at page level so
 * permission and calibration survive switching between lobby and game screens.
 * @param {{ onShake?: () => void }} options called for every accepted shake (sensor or button)
 */
export function useControllerInput({ onShake } = {}) {
  const [shakeCount, setShakeCount] = useState(0);
  const onShakeRef = useRef(onShake);
  useEffect(() => {
    onShakeRef.current = onShake;
  });

  const shake = useCallback(() => {
    setShakeCount((n) => n + 1);
    onShakeRef.current?.();
  }, []);

  const motion = useMotion({ onShake: shake });
  const [touchChosen, setTouchChosen] = useState(false);
  const touchMode = touchChosen || ['denied', 'unsupported', 'insecure'].includes(motion.status);
  const touchReason = touchMode ? TOUCH_REASONS[touchChosen ? 'chosen' : motion.status] : null;

  const touchVectorRef = useRef(ZERO);
  const modeRef = useRef({ touchMode, motionReady: false });
  useEffect(() => {
    modeRef.current = {
      touchMode,
      motionReady: motion.status === 'granted' && motion.calibrated,
    };
    if (!touchMode) touchVectorRef.current = ZERO;
  }, [touchMode, motion.status, motion.calibrated]);

  const { getTilt } = motion;
  /** Latest movement vector from whichever source is active. Stable; cheap to poll. */
  const getInput = useCallback(() => {
    const mode = modeRef.current;
    if (mode.touchMode) return touchVectorRef.current;
    return mode.motionReady ? getTilt() : ZERO;
  }, [getTilt]);

  const setTouchVector = useCallback((x, y) => {
    touchVectorRef.current = clampVector(x, y);
  }, []);

  // The SHAKE button uses the same cooldown as the sensor so both feel identical.
  const lastTouchShakeRef = useRef(Number.NEGATIVE_INFINITY);
  const touchShake = useCallback(() => {
    const now = performance.now();
    if (now - lastTouchShakeRef.current < MOTION_DEFAULTS.shakeCooldownMs) return false;
    lastTouchShakeRef.current = now;
    shake();
    return true;
  }, [shake]);

  const { disable, enable } = motion;
  const chooseTouch = useCallback(() => {
    disable();
    setTouchChosen(true);
  }, [disable]);

  /** Call from a tap handler: requests sensor permission in the same gesture. */
  const chooseMotion = useCallback(() => {
    setTouchChosen(false);
    return enable();
  }, [enable]);

  return {
    motion,
    touchMode,
    touchReason,
    shakeCount,
    getInput,
    setTouchVector,
    touchShake,
    chooseTouch,
    chooseMotion,
  };
}
