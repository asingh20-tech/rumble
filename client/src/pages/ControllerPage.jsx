import { useParams } from 'react-router-dom';

export default function ControllerPage() {
  const { code } = useParams();

  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="neon-title text-5xl">CONTROLLER</h1>
      <p className="text-xl text-neon-pink">{code ? `Room ${code.toUpperCase()}` : 'No room code'}</p>
    </main>
  );
}
