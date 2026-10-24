import { useCallback, useEffect, useRef, useState } from 'react';
import { EVENTS } from '@rumble/shared/protocol';
import { socket } from './socket.js';
import { INPUT_POLL_MS, createInputSender } from './inputSender.js';

const SHAKE_ACK_TIMEOUT_MS = 3000;

/**
 * Stream player:input while `active`. Polls getInput() every INPUT_POLL_MS and lets the
 * throttle decide what to send. Uses volatile emits: if the socket is down, input is dropped
 * instead of queued and replayed in a burst on reconnect. When the page is hidden (phone
 * locked, app switch) a final {0,0} is sent so the player doesn't keep drifting.
 * @param {{ active: boolean, getInput: () => { x: number, y: number } }} options
 */
export function useInputStream({ active, getInput }) {
  const getInputRef = useRef(getInput);
  useEffect(() => {
    getInputRef.current = getInput;
  });
  const [sender] = useState(() =>
    createInputSender({ send: (payload) => socket.volatile.emit(EVENTS.PLAYER_INPUT, payload) }),
  );

  useEffect(() => {
    if (!active) return;
    sender.reset();

    const tick = () => {
      if (!socket.connected || document.visibilityState !== 'visible') return;
      const { x, y } = getInputRef.current();
      sender.update(x, y);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && socket.connected) {
        sender.reset();
        sender.update(0, 0);
      }
    };

    const timer = setInterval(tick, INPUT_POLL_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [active, sender]);
}

/**
 * Returns a stable sendShake() that emits player:shake { seq } with an increasing seq.
 * Shakes are skipped (not queued) while disconnected. `onAck` receives the server's
 * AckResult<{ accepted, charge }>.
 * @param {(result: { ok: boolean, accepted?: boolean, charge?: number }) => void} [onAck]
 */
export function useShakeSender(onAck) {
  const seqRef = useRef(0);
  const onAckRef = useRef(onAck);
  useEffect(() => {
    onAckRef.current = onAck;
  });

  return useCallback(() => {
    if (!socket.connected) return false;
    const seq = seqRef.current;
    seqRef.current += 1;
    socket.timeout(SHAKE_ACK_TIMEOUT_MS).emit(EVENTS.PLAYER_SHAKE, { seq }, (err, res) => {
      if (!err && res) onAckRef.current?.(res);
    });
    return true;
  }, []);
}
