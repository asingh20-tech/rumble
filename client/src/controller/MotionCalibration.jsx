import { useEffect, useRef, useState } from 'react';
import { Crosshair, Hand, Loader2, Smartphone } from 'lucide-react';
import { SENSITIVITY_MAX, SENSITIVITY_MIN } from './motionMath.js';
import { ShakeButton, VirtualJoystick } from './TouchControls.jsx';

const fmt = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);

/**
 * Re-render-free live view of the current input: calls `draw(x, y)` every animation frame.
 * @param {() => { x: number, y: number }} getInput
 * @param {(x: number, y: number) => void} draw
 */
function useInputFrames(getInput, draw) {
  const drawRef = useRef(draw);
  useEffect(() => {
    drawRef.current = draw;
  });
  useEffect(() => {
    let frame = 0;
    const loop = () => {
      const { x, y } = getInput();
      drawRef.current(x, y);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [getInput]);
}

/** Numeric x / y that update every frame without re-rendering. */
function InputNumbers({ getInput }) {
  const xRef = useRef(null);
  const yRef = useRef(null);
  useInputFrames(getInput, (x, y) => {
    if (xRef.current) xRef.current.textContent = fmt(x);
    if (yRef.current) yRef.current.textContent = fmt(y);
  });
  return (
    <p className="font-mono text-xl font-bold text-slate-200 tabular-nums">
      X <span ref={xRef}>+0.00</span>
      <span className="mx-3 text-slate-600">·</span>Y <span ref={yRef}>+0.00</span>
    </p>
  );
}

/** Circle with a glowing dot that follows the tilt vector. */
function TiltMeter({ getInput, calibrating }) {
  const dotRef = useRef(null);
  const meterRef = useRef(null);
  useInputFrames(getInput, (x, y) => {
    const meter = meterRef.current;
    if (!meter || !dotRef.current) return;
    // Dot (22% of the meter) travels up to the rim.
    const travel = meter.clientWidth * 0.39;
    dotRef.current.style.transform = `translate(${x * travel}px, ${y * travel}px)`;
  });
  return (
    <div
      ref={meterRef}
      className={`tilt-meter${calibrating ? ' is-calibrating' : ''}`}
      aria-hidden="true"
    >
      <div ref={dotRef} className="tilt-dot" />
    </div>
  );
}

/** Shake counter that flashes on every shake, plus what the server made of the last one. */
function ShakeCounter({ count, serverShake, stacked = false }) {
  return (
    <div
      className={
        stacked
          ? 'flex w-24 flex-col items-center leading-tight'
          : 'flex items-baseline justify-center gap-3'
      }
    >
      <span className="text-sm font-bold tracking-widest text-slate-400 uppercase">Shakes</span>
      <span key={count} className="shake-flash inline-block text-3xl font-black text-white">
        {count}
      </span>
      {serverShake && (
        <span
          className={`text-sm font-semibold ${serverShake.accepted ? 'text-neon-green' : 'text-slate-500'}`}
        >
          {serverShake.accepted ? 'server ✓' : 'server skipped'}
        </span>
      )}
    </div>
  );
}

function SensitivitySlider({ value, onChange }) {
  return (
    <label className="flex w-full items-center gap-3 text-left">
      <span className="text-sm font-bold tracking-widest text-slate-400 uppercase">Sens</span>
      <input
        type="range"
        min={SENSITIVITY_MIN}
        max={SENSITIVITY_MAX}
        step={0.1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-10 flex-1"
        aria-label="Tilt sensitivity"
      />
      <span className="w-12 text-right font-mono text-lg font-bold text-white tabular-nums">
        {value.toFixed(1)}x
      </span>
    </label>
  );
}

const secondaryButton =
  'flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-slate-600 px-5 text-base font-semibold tracking-wider text-slate-300 uppercase active:bg-slate-800';

/**
 * Motion setup on the "waiting for host" screen:
 * ENABLE MOTION CONTROLS → hold flat + CALIBRATE → live tilt dot, x/y and shake counter.
 * Falls back to a clearly labeled TOUCH MODE (joystick + SHAKE) when sensors are denied,
 * missing, or the page isn't on https.
 * @param {{ controls: ReturnType<typeof import('./useControllerInput.js').useControllerInput>,
 *           color: string, serverShake: { accepted: boolean, charge: number } | null }} props
 */
export default function MotionCalibration({ controls, color, serverShake }) {
  const { motion, touchMode } = controls;
  const [calibrationFailed, setCalibrationFailed] = useState(false);

  const calibrate = () => {
    setCalibrationFailed(false);
    motion.calibrate().then((ok) => setCalibrationFailed(!ok));
  };

  return (
    <section
      className="flex w-full max-w-sm flex-col items-center gap-[min(0.75rem,1.6dvh)]"
      style={{ '--player-color': color }}
      aria-label="Controls setup"
    >
      {touchMode ? (
        <TouchPanel controls={controls} serverShake={serverShake} />
      ) : motion.status === 'idle' ? (
        <>
          <button
            type="button"
            onClick={() => {
              setCalibrationFailed(false);
              controls.chooseMotion();
            }}
            className="flex min-h-20 w-full items-center justify-center gap-3 rounded-2xl bg-rumble-purple px-4 text-2xl font-black tracking-[0.12em] text-white uppercase shadow-[0_0_32px_rgb(168_85_247/0.7)] active:scale-95"
          >
            <Smartphone size={30} aria-hidden="true" />
            Enable motion controls
          </button>
          <p className="text-base text-slate-400">Tilt to move · shake to charge</p>
          <button type="button" onClick={controls.chooseTouch} className={secondaryButton}>
            <Hand size={18} aria-hidden="true" />
            Use touch controls
          </button>
        </>
      ) : !motion.calibrated ? (
        <>
          <TiltMeter getInput={controls.getInput} calibrating={motion.calibrating} />
          <p className="text-xl font-bold text-white">
            Hold your phone flat and comfortable, tap{' '}
            <span className="text-neon-cyan">CALIBRATE</span>
          </p>
          {calibrationFailed && (
            <p role="alert" className="text-base font-semibold text-neon-pink">
              No sensor readings yet. Hold still and try again.
            </p>
          )}
          <CalibrateButton calibrating={motion.calibrating} onClick={calibrate} primary />
        </>
      ) : (
        <>
          <TiltMeter getInput={controls.getInput} calibrating={motion.calibrating} />
          <InputNumbers getInput={controls.getInput} />
          <ShakeCounter count={controls.shakeCount} serverShake={serverShake} />
          {!motion.support.motion && (
            <ShakeButton onShake={controls.touchShake} className="w-full" />
          )}
          <SensitivitySlider value={motion.sensitivity} onChange={motion.setSensitivity} />
          {calibrationFailed && (
            <p role="alert" className="text-base font-semibold text-neon-pink">
              No sensor readings. Hold still and try again.
            </p>
          )}
          <div className="flex w-full gap-3">
            <CalibrateButton calibrating={motion.calibrating} onClick={calibrate} />
            <button
              type="button"
              onClick={controls.chooseTouch}
              className={`${secondaryButton} flex-1`}
            >
              <Hand size={18} aria-hidden="true" />
              Touch
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function CalibrateButton({ calibrating, onClick, primary = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={calibrating}
      className={
        primary
          ? 'flex min-h-20 w-full items-center justify-center gap-3 rounded-2xl bg-neon-cyan text-2xl font-black tracking-[0.2em] text-rumble-bg uppercase shadow-[0_0_32px_rgb(34_211_238/0.6)] active:scale-95 disabled:opacity-70'
          : `${secondaryButton} flex-1 disabled:opacity-60`
      }
    >
      {calibrating ? (
        <Loader2 className="animate-spin" size={primary ? 28 : 18} aria-hidden="true" />
      ) : (
        <Crosshair size={primary ? 28 : 18} aria-hidden="true" />
      )}
      {calibrating ? 'Hold still' : primary ? 'Calibrate' : 'Recalibrate'}
    </button>
  );
}

function TouchPanel({ controls, serverShake }) {
  const { motion, touchReason } = controls;
  // Retrying makes sense if the player opted out, or after a denial (iOS may re-prompt once
  // the tab is reopened). Missing sensors or http:// can't be fixed by tapping.
  const canRetry = motion.status === 'idle' || motion.status === 'denied';
  return (
    <>
      <div className="flex flex-col items-center gap-1">
        <p className="rounded-full border-2 border-neon-yellow px-5 py-0.5 text-lg font-black tracking-[0.25em] text-neon-yellow uppercase">
          Touch mode
        </p>
        <p className="text-sm text-slate-400">{touchReason}</p>
        {motion.status === 'denied' && (
          <p className="text-sm text-slate-500">
            To use tilt, close this tab, reopen the link and tap Allow.
          </p>
        )}
      </div>
      <VirtualJoystick onChange={controls.setTouchVector} />
      <div className="flex w-full items-center gap-4">
        <ShakeButton onShake={controls.touchShake} className="flex-1" />
        <ShakeCounter count={controls.shakeCount} serverShake={serverShake} stacked />
      </div>
      {canRetry && (
        <button type="button" onClick={controls.chooseMotion} className={secondaryButton}>
          <Smartphone size={18} aria-hidden="true" />
          Try motion controls
        </button>
      )}
    </>
  );
}
