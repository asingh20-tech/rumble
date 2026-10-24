import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import ConnectionIndicator from './components/ConnectionIndicator.jsx';
import HomePage from './pages/HomePage.jsx';
import HostPage from './pages/HostPage.jsx';
import ControllerPage from './pages/ControllerPage.jsx';

// M3 visual sandbox only. Remove this dev-only entry when M4 adds game routing.
const ArenaPreview = import.meta.env.DEV ? lazy(() => import('./game/ArenaPreview.jsx')) : null;

export default function App() {
  const { pathname } = useLocation();
  if (import.meta.env.DEV && pathname === '/arena-preview') {
    // Keep the sandbox separate from the lobby's connection indicator/socket effects.
    return <Suspense fallback={<main className="arena-preview-loading" role="status">Loading arena preview…</main>}><ArenaPreview /></Suspense>;
  }
  return (
    <>
      <ConnectionIndicator />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/host" element={<HostPage />} />
        <Route path="/play/:code?" element={<ControllerPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
