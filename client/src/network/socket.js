import { io } from 'socket.io-client';

// Single shared socket for the whole app. With no VITE_SERVER_URL it connects to the page's
// own origin, which Vite proxies to the backend (works on localhost and via cloudflared).
export const socket = io(import.meta.env.VITE_SERVER_URL || undefined, { autoConnect: false });
