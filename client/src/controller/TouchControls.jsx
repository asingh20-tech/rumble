import { useEffect, useRef } from 'react';
import { Zap } from 'lucide-react';

/** Knob travel (fraction of radius) under which the stick reads as centered. */
const DEAD_ZONE = 0.08;

/**
 * Virtual joystick. Reports a vector with length <= 1 (right/down positive) via onChange,
 * and snaps back to center on release. Uses pointer capture so the drag keeps tracking
 * when the finger leaves the pad.
 * @param {{ onChange: (x: number, y: number) => void }} props
 */
export function VirtualJoystick({ onChange }) {
  const padRef = useRef(null);
  const knobRef = useRef(null);
  const pointerRef = useRef(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  const update = (clientX, clientY) => {
    const pad = padRef.current;
    if (!pad) return;
    const rect = pad.getBoundingClientRect();
    const radius = rect.width / 2;
    let dx = (clientX - (rect.left + radius)) / radius;
    let dy = (clientY - (rect.top + radius)) / radius;
    const length = Math.hypot(dx, dy);
    if (length > 1) {
      dx /= length;
      dy /= length;
    }
    // Knob travels up to the pad edge; its own size is 40% of the pad.
    knobRef.current.style.transform = `translate(${dx * radius * 0.6}px, ${dy * radius * 0.6}px)`;
    const live = Math.hypot(dx, dy) < DEAD_ZONE;
    onChangeRef.current(live ? 0 : dx, live ? 0 : dy);
  };

  const release = () => {
    pointerRef.current = null;
    if (knobRef.current) knobRef.current.style.transform = '';
    onChangeRef.current(0, 0);
  };

  // Never leave the player drifting if this unmounts mid-drag.
  useEffect(() => () => onChangeRef.current(0, 0), []);

  return (
    <div
      ref={padRef}
      className="joystick"
      role="application"
      aria-label="Movement joystick: drag to move"
      onPointerDown={(e) => {
        if (pointerRef.current != null) return;
        e.preventDefault();
        pointerRef.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        update(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (e.pointerId === pointerRef.current) update(e.clientX, e.clientY);
      }}
      onPointerUp={(e) => {
        if (e.pointerId === pointerRef.current) release();
      }}
      onPointerCancel={(e) => {
        if (e.pointerId === pointerRef.current) release();
      }}
      onLostPointerCapture={(e) => {
        if (e.pointerId === pointerRef.current) release();
      }}
    >
      <div ref={knobRef} className="joystick-knob" />
    </div>
  );
}

/**
 * Big tap target standing in for a physical shake.
 * @param {{ onShake: () => void, className?: string }} props
 */
export function ShakeButton({ onShake, className = '' }) {
  return (
    <button
      type="button"
      onPointerDown={(e) => {
        // Fire on press, not release: it's an arcade button.
        e.preventDefault();
        onShake();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onShake();
        }
      }}
      className={`flex min-h-16 items-center justify-center gap-3 rounded-2xl border-2 border-neon-yellow bg-neon-yellow/15 px-8 text-2xl font-black tracking-[0.2em] text-neon-yellow uppercase shadow-[0_0_24px_rgb(251_191_36/0.45)] active:scale-95 active:bg-neon-yellow/30 ${className}`}
    >
      <Zap size={28} aria-hidden="true" />
      Shake
    </button>
  );
}
