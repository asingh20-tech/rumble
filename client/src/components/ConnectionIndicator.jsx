import { Wifi, WifiOff } from 'lucide-react';
import { useConnectionStatus } from '../network/useConnectionStatus.js';

export default function ConnectionIndicator() {
  const connected = useConnectionStatus();
  const Icon = connected ? Wifi : WifiOff;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed top-[max(0.75rem,env(safe-area-inset-top))] right-3 z-50 flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold tracking-wider uppercase backdrop-blur ${
        connected
          ? 'border-neon-green/50 bg-neon-green/10 text-neon-green'
          : 'border-neon-pink/50 bg-neon-pink/10 text-neon-pink'
      }`}
    >
      <Icon size={14} aria-hidden="true" />
      {connected ? 'Connected' : 'Disconnected'}
    </div>
  );
}
