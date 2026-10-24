import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Loader2, LogIn, RotateCcw, WifiOff } from 'lucide-react';
import { EVENTS, ERROR_CODES } from '@rumble/shared/protocol';
import {
  NAME_MAX_LENGTH,
  PLAYER_COLORS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from '@rumble/shared/constants';
import { socket } from '../network/socket.js';
import { clearSession, loadSession, saveSession } from '../network/session.js';
import { useConnectionStatus } from '../network/useConnectionStatus.js';

const ACK_TIMEOUT_MS = 8000;

const ERROR_MESSAGES = {
  [ERROR_CODES.ROOM_NOT_FOUND]: "We couldn't find that room. Check the code on the big screen.",
  [ERROR_CODES.ROOM_FULL]: 'This arena is full. Catch the next game!',
  [ERROR_CODES.GAME_IN_PROGRESS]: 'A round is already underway. Join the next lobby!',
  [ERROR_CODES.INVALID_NAME]: `Pick a nickname with 1-${NAME_MAX_LENGTH} characters.`,
  [ERROR_CODES.NOT_HOST]: 'Only the host screen can do that.',
  [ERROR_CODES.NOT_ENOUGH_PLAYERS]: 'Not enough players to start yet.',
  [ERROR_CODES.RATE_LIMITED]: 'Whoa, slow down! Try again in a second.',
  [ERROR_CODES.BAD_INPUT]: "Something didn't look right. Check the room code and try again.",
};
const TIMEOUT_MESSAGE = "The server isn't answering. Check your connection and try again.";
const SEAT_EXPIRED_MESSAGE = 'Your spot in that room expired. Join again!';
const CLOSED_MESSAGES = {
  host_left: 'The host left, so the room closed.',
  expired: 'This room expired.',
};

const friendly = (code) => ERROR_MESSAGES[code] ?? 'Something went wrong. Try again.';

/** Uppercase and keep only valid room-code characters. */
function cleanCodeInput(value) {
  return [...value.toUpperCase()]
    .filter((c) => ROOM_CODE_ALPHABET.includes(c))
    .join('')
    .slice(0, ROOM_CODE_LENGTH);
}

/** Limit by code points so emoji count as one character, like the server. */
function clampName(value) {
  return Array.from(value).slice(0, NAME_MAX_LENGTH).join('');
}

export default function ControllerPage() {
  const params = useParams();
  const navigate = useNavigate();
  const connected = useConnectionStatus();
  const urlCode = cleanCodeInput(params.code ?? '');

  // A saved seat is reused when it belongs to the room in the URL (or the URL has no code).
  const [initialSession] = useState(() => {
    const stored = loadSession();
    return stored && (!urlCode || stored.code === urlCode) ? stored : null;
  });
  const sessionRef = useRef(initialSession);
  const mountedRef = useRef(false);

  const [status, setStatus] = useState(initialSession ? 'rejoining' : 'idle');
  const [room, setRoom] = useState(null);
  const [error, setError] = useState('');
  const [code, setCode] = useState(urlCode || initialSession?.code || '');
  const [name, setName] = useState('');

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Lock down the page for touch play: no rubber-band scrolling or pull-to-refresh.
  useEffect(() => {
    const { style } = document.body;
    const previous = style.overscrollBehavior;
    style.overscrollBehavior = 'none';
    return () => {
      style.overscrollBehavior = previous;
    };
  }, []);

  useEffect(() => {
    let active = true;

    const forgetSeat = (message) => {
      clearSession();
      sessionRef.current = null;
      setRoom(null);
      setStatus('idle');
      setError(message);
    };

    // Reclaim our seat. Runs on mount and after every (re)connect of the socket.
    const rejoin = () => {
      const session = sessionRef.current;
      if (!session) return;
      socket.timeout(ACK_TIMEOUT_MS).emit(EVENTS.ROOM_REJOIN, session, (err, res) => {
        if (!active || sessionRef.current !== session) return;
        if (err) {
          setError(TIMEOUT_MESSAGE);
          return;
        }
        if (!res.ok) {
          if (res.code === ERROR_CODES.ROOM_NOT_FOUND) forgetSeat(friendly(res.code));
          else if (res.code === ERROR_CODES.BAD_INPUT) forgetSeat(SEAT_EXPIRED_MESSAGE);
          else setError(friendly(res.code));
          return;
        }
        setRoom(res.room);
        setStatus('joined');
        setError('');
      });
    };

    const onUpdate = (snapshot) => {
      const session = sessionRef.current;
      if (!session || snapshot?.code !== session.code) return;
      if (!snapshot.players.some((p) => p.id === session.playerId)) {
        forgetSeat(SEAT_EXPIRED_MESSAGE);
        return;
      }
      setRoom(snapshot);
    };

    const onClosed = (payload) => {
      if (!sessionRef.current || payload?.code !== sessionRef.current.code) return;
      clearSession();
      sessionRef.current = null;
      setRoom(null);
      setStatus('closed');
      setCode('');
      setError(CLOSED_MESSAGES[payload.reason] ?? CLOSED_MESSAGES.expired);
    };

    const onServerError = (payload) => {
      if (payload?.code) setError(friendly(payload.code));
    };

    socket.on('connect', rejoin);
    socket.on(EVENTS.ROOM_UPDATE, onUpdate);
    socket.on(EVENTS.ROOM_CLOSED, onClosed);
    socket.on(EVENTS.ERROR, onServerError);
    if (!socket.active) socket.connect();
    if (socket.connected) rejoin();

    return () => {
      active = false;
      socket.off('connect', rejoin);
      socket.off(EVENTS.ROOM_UPDATE, onUpdate);
      socket.off(EVENTS.ROOM_CLOSED, onClosed);
      socket.off(EVENTS.ERROR, onServerError);
    };
  }, []);

  const join = (event) => {
    event.preventDefault();
    if (status === 'joining') return;
    const roomCode = cleanCodeInput(code);
    const nickname = name.trim();
    if (roomCode.length !== ROOM_CODE_LENGTH) {
      setError(`Room codes are ${ROOM_CODE_LENGTH} characters. Check the big screen.`);
      return;
    }
    if (!nickname) {
      setError(friendly(ERROR_CODES.INVALID_NAME));
      return;
    }

    setStatus('joining');
    setError('');
    socket
      .timeout(ACK_TIMEOUT_MS)
      .emit(EVENTS.ROOM_JOIN, { code: roomCode, name: nickname }, (err, res) => {
        if (!mountedRef.current) return;
        if (err || !res.ok) {
          setStatus('idle');
          setError(err ? TIMEOUT_MESSAGE : friendly(res.code));
          return;
        }
        const session = {
          code: res.room.code,
          playerId: res.playerId,
          reconnectToken: res.reconnectToken,
        };
        saveSession(session);
        sessionRef.current = session;
        setRoom(res.room);
        setStatus('joined');
        if (urlCode !== session.code) navigate(`/play/${session.code}`, { replace: true });
      });
  };

  const startOver = () => {
    clearSession();
    sessionRef.current = null;
    setRoom(null);
    setStatus('idle');
    setError('');
  };

  const me = room?.players.find((p) => p.id === sessionRef.current?.playerId);

  return (
    <main className="flex min-h-full touch-manipulation flex-col items-center justify-center gap-8 overflow-hidden px-6 pt-[max(4rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))] text-center select-none">
      <h1 className="neon-title text-5xl">RUMBLE</h1>

      {status === 'joined' && me ? (
        <Lobby me={me} room={room} connected={connected} />
      ) : status === 'rejoining' || (status === 'joined' && !me) ? (
        <div className="flex w-full max-w-sm flex-col items-center gap-6">
          <Loader2 className="animate-spin text-rumble-purple" size={56} aria-hidden="true" />
          <p className="text-2xl font-bold tracking-widest text-white uppercase">Reconnecting…</p>
          <ErrorText message={error} />
          <button
            type="button"
            onClick={startOver}
            className="flex min-h-14 items-center gap-2 rounded-2xl border border-slate-600 px-6 text-lg font-semibold tracking-wider text-slate-300 uppercase active:bg-slate-800"
          >
            <RotateCcw size={20} aria-hidden="true" />
            Join as new player
          </button>
        </div>
      ) : (
        <form onSubmit={join} className="flex w-full max-w-sm flex-col gap-5" noValidate>
          {status === 'closed' && (
            <p className="rounded-2xl border border-neon-pink/60 bg-neon-pink/10 px-4 py-3 text-lg font-semibold text-neon-pink">
              Room closed
            </p>
          )}

          {urlCode && status !== 'closed' ? (
            <p className="text-lg tracking-widest text-slate-300 uppercase">
              Room <span className="font-black text-neon-cyan">{urlCode}</span>
            </p>
          ) : (
            <label className="flex flex-col gap-2 text-left">
              <span className="text-sm font-bold tracking-widest text-slate-400 uppercase">
                Room code
              </span>
              <input
                value={code}
                onChange={(e) => setCode(cleanCodeInput(e.target.value))}
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="ABC234"
                className="h-16 rounded-2xl border-2 border-rumble-purple/60 bg-rumble-arena px-4 text-center text-3xl font-black tracking-[0.4em] text-white uppercase outline-none select-text placeholder:text-slate-600 focus:border-neon-cyan"
              />
            </label>
          )}

          <label className="flex flex-col gap-2 text-left">
            <span className="text-sm font-bold tracking-widest text-slate-400 uppercase">
              Nickname
            </span>
            <input
              value={name}
              onChange={(e) => setName(clampName(e.target.value))}
              autoComplete="nickname"
              autoCorrect="off"
              enterKeyHint="go"
              placeholder="Your name"
              className="h-16 rounded-2xl border-2 border-rumble-purple/60 bg-rumble-arena px-4 text-center text-2xl font-bold text-white outline-none select-text placeholder:text-slate-600 focus:border-neon-cyan"
            />
          </label>

          <ErrorText message={error} />

          <button
            type="submit"
            disabled={status === 'joining'}
            className="flex min-h-20 items-center justify-center gap-3 rounded-2xl bg-rumble-purple text-3xl font-black tracking-[0.2em] text-white uppercase shadow-[0_0_32px_rgb(168_85_247/0.7)] transition active:scale-95 disabled:opacity-60"
          >
            {status === 'joining' ? (
              <Loader2 className="animate-spin" size={32} aria-hidden="true" />
            ) : (
              <LogIn size={32} aria-hidden="true" />
            )}
            {status === 'joining' ? 'Joining' : 'Join'}
          </button>

          {!connected && (
            <p className="flex items-center justify-center gap-2 text-sm text-slate-400">
              <WifiOff size={16} aria-hidden="true" />
              Connecting to server…
            </p>
          )}
        </form>
      )}
    </main>
  );
}

function ErrorText({ message }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-lg font-semibold text-neon-pink">
      {message}
    </p>
  );
}

function Lobby({ me, room, connected }) {
  const color = PLAYER_COLORS[me.colorIndex]?.hex ?? PLAYER_COLORS[0].hex;
  const waitingText =
    room.phase === 'lobby'
      ? 'Waiting for host'
      : room.phase === 'results'
        ? 'Round over'
        : 'Get ready';

  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-8">
      <div
        className="size-40 animate-pulse rounded-full border-4"
        style={{
          borderColor: color,
          backgroundColor: `${color}33`,
          boxShadow: `0 0 32px ${color}, inset 0 0 32px ${color}`,
        }}
        aria-hidden="true"
      />
      <div className="flex flex-col gap-2">
        <p
          className="text-5xl font-black break-all"
          style={{ color, textShadow: `0 0 16px ${color}` }}
        >
          {me.name}
        </p>
        <p className="text-lg tracking-widest text-slate-400 uppercase">
          {PLAYER_COLORS[me.colorIndex]?.name} · Room {room.code}
        </p>
      </div>
      <p className="text-3xl font-black tracking-[0.2em] text-white uppercase">{waitingText}</p>
      <p className="text-lg text-slate-300">
        {room.players.length} / {room.maxPlayers} players in
      </p>
      {!connected && (
        <p className="flex items-center gap-2 text-lg font-semibold text-neon-yellow">
          <WifiOff size={20} aria-hidden="true" />
          Connection lost. Reconnecting…
        </p>
      )}
    </div>
  );
}
