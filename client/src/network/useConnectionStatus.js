import { useEffect, useState } from 'react';
import { socket } from './socket.js';

/**
 * Subscribe to the shared socket's connection state, opening the connection if needed.
 * The socket is intentionally left open on unmount so page changes don't drop it.
 * @returns {boolean} true while connected
 */
export function useConnectionStatus() {
  const [connected, setConnected] = useState(socket.connected);

  useEffect(() => {
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onDisconnect);
    if (!socket.active) socket.connect();
    setConnected(socket.connected);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onDisconnect);
    };
  }, []);

  return connected;
}
