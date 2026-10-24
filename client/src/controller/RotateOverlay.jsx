import { Smartphone } from 'lucide-react';

/**
 * Full-screen "rotate to portrait" prompt. Always rendered; controller.css only shows it on
 * touch phones held in landscape (iOS Safari can't lock orientation).
 */
export default function RotateOverlay() {
  return (
    <div className="rotate-overlay" aria-live="polite">
      <Smartphone size={72} aria-hidden="true" />
      <p>Rotate to portrait</p>
    </div>
  );
}
