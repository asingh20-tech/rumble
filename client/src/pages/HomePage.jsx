import { Link } from 'react-router-dom';

export default function HomePage() {
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="neon-title text-6xl sm:text-8xl">RUMBLE</h1>
      <p className="text-lg text-slate-300">Your phone is the controller. Your friends are the enemies.</p>
      <Link
        to="/host"
        className="rounded-xl bg-rumble-purple px-8 py-3 text-lg font-bold tracking-widest text-white uppercase shadow-[0_0_24px_rgb(168_85_247/0.6)]"
      >
        Host a game
      </Link>
    </main>
  );
}
