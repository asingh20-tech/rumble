import { Navigate, Route, Routes } from 'react-router-dom';
import ConnectionIndicator from './components/ConnectionIndicator.jsx';
import HomePage from './pages/HomePage.jsx';
import HostPage from './pages/HostPage.jsx';
import ControllerPage from './pages/ControllerPage.jsx';

export default function App() {
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
