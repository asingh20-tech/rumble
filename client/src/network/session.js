// Phone controller session, persisted so a reload or dropped connection can reclaim the seat.
// localStorage can throw (private mode, blocked storage), so every access is guarded.

const STORAGE_KEY = 'rumble:session';

/**
 * @returns {{ code: string, playerId: string, reconnectToken: string } | null}
 */
export function loadSession() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (
      typeof data?.code === 'string' &&
      typeof data.playerId === 'string' &&
      typeof data.reconnectToken === 'string'
    ) {
      return { code: data.code, playerId: data.playerId, reconnectToken: data.reconnectToken };
    }
  } catch {
    // Corrupt or unavailable storage: behave as if nothing was saved.
  }
  return null;
}

/** @param {{ code: string, playerId: string, reconnectToken: string }} session */
export function saveSession({ code, playerId, reconnectToken }) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ code, playerId, reconnectToken }));
  } catch {
    // Storage unavailable: the player can still play, they just can't survive a reload.
  }
}

export function clearSession() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}
