import { Link } from 'react-router-dom';

export default function HomePage() {
  return (
    <main className="arcade-page home-page">
      <p className="arcade-eyebrow text-neon-cyan">THE PARTY STARTS HERE</p>
      <h1 className="neon-title">RUMBLE</h1>
      <p className="home-tagline">Your phone is the controller.<br />Your friends are the enemies.</p>
      <Link to="/host" className="arcade-button">HOST A GAME <span aria-hidden="true">→</span></Link>
      <Link to="/play" className="home-join-link">Got a room code? Join on your phone</Link>
      <p className="arcade-eyebrow home-footnote">ONE BIG SCREEN. YOUR PHONES. TOTAL CHAOS.</p>
    </main>
  );
}
