import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Move, Smartphone, Sparkles, X, Zap } from 'lucide-react';
import { MAX_PLAYERS, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@rumble/shared/constants';

const particles = Array.from({ length: 28 }, (_, index) => ({
  left: `${(index * 37 + 11) % 100}%`,
  top: `${(index * 23 + 7) % 100}%`,
  '--drift-delay': `${index * -0.9}s`,
  '--drift-duration': `${16 + (index % 7) * 3}s`,
  '--particle-size': `${index % 5 === 0 ? 3 : 2}px`,
}));

export default function HomePage() {
  const navigate = useNavigate();
  const joinButton = useRef(null);
  const [joining, setJoining] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  function closeJoin() {
    setJoining(false);
    setError('');
    joinButton.current?.focus();
  }
  function join(event) {
    event.preventDefault();
    const normalized = code.trim().toUpperCase();
    if (normalized.length !== ROOM_CODE_LENGTH || ![...normalized].every((char) => ROOM_CODE_ALPHABET.includes(char))) {
      setError(`Enter the ${ROOM_CODE_LENGTH}-character room code shown on the host’s screen.`);
      return;
    }
    navigate(`/play/${normalized}`);
  }

  return (
    <main className="arcade-page home-page">
      <div className="home-atmosphere" aria-hidden="true">
        <div className="home-glow home-glow-purple" />
        <div className="home-glow home-glow-cyan" />
        <div className="home-glow home-glow-pink" />
        <div className="home-floor" />
        <div className="home-orbit home-orbit-one" /><div className="home-orbit home-orbit-two" />
        {particles.map((style, index) => <span className="home-particle" key={index} style={style} />)}
      </div>
      <header className="home-header">
        <span className="home-mini-brand"><Sparkles size={16} aria-hidden="true" /> RUMBLE / PARTY SYSTEM</span>
        <span className="home-browser-badge"><span /> NO DOWNLOADS. JUST RIVALS.</span>
      </header>
      <section className="home-hero" aria-labelledby="home-title">
        <p className="arcade-eyebrow home-kicker"><span /> GAME NIGHT. UPGRADED.</p>
        <h1 className="home-logo" id="home-title">RUMBLE</h1>
        <p className="home-tagline">Your phone is the controller.<br />Your friends are the enemies.</p>
        <div className="home-actions">
          <Link to="/host" className="home-action home-action-primary">HOST A GAME <ArrowRight size={20} aria-hidden="true" /></Link>
          <button ref={joinButton} type="button" className="home-action home-action-secondary" aria-expanded={joining} aria-controls="home-join-form" onClick={() => joining ? closeJoin() : setJoining(true)}>
            JOIN A GAME <Smartphone size={20} aria-hidden="true" />
          </button>
        </div>
        {joining && (
          <form id="home-join-form" className="home-code-panel" onSubmit={join} noValidate onKeyDown={(event) => { if (event.key === 'Escape') closeJoin(); }}>
            <div className="home-code-heading"><label htmlFor="home-room-code">GOT A ROOM CODE?</label><button type="button" onClick={closeJoin} aria-label="Close room code entry"><X size={18} aria-hidden="true" /></button></div>
            <div className="home-code-controls">
              <input id="home-room-code" value={code} onChange={(event) => { setCode(event.target.value.toUpperCase().replace(/\s/g, '').slice(0, ROOM_CODE_LENGTH)); setError(''); }}
                maxLength={ROOM_CODE_LENGTH} autoFocus autoCapitalize="characters" autoComplete="off" autoCorrect="off" spellCheck={false} inputMode="text" placeholder="ABC234" aria-invalid={Boolean(error)} aria-describedby="home-code-help" />
              <button type="submit" className="home-code-submit" aria-label="Join room">LET’S GO <ArrowRight size={18} aria-hidden="true" /></button>
            </div>
            <p id="home-code-help" className={error ? 'home-code-error' : 'home-code-hint'} role={error ? 'alert' : undefined}>{error || 'Find the code on the big screen.'}</p>
          </form>
        )}
        <p className="home-player-note">ONE BIG SCREEN <span>✳</span> UP TO {MAX_PLAYERS} PLAYERS <span>✳</span> ZERO CHILL</p>
      </section>
      <section className="home-how" aria-label="How to play">
        <p>Tilt to move. Shake to attack. Knock your friends out.</p>
        <div className="home-how-steps">
          <span><Move size={17} aria-hidden="true" /> TILT</span><span className="home-step-line" aria-hidden="true" />
          <span><Zap size={17} aria-hidden="true" /> SHAKE</span><span className="home-step-line" aria-hidden="true" />
          <span><Sparkles size={17} aria-hidden="true" /> RUMBLE</span>
        </div>
      </section>
    </main>
  );
}
