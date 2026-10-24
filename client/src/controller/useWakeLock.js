import { useEffect } from 'react';

/**
 * Keep the screen on while `active` (lobby and match), so the phone doesn't dim mid-round.
 * The browser drops the lock whenever the page is hidden, so it is re-acquired when the page
 * becomes visible again. Some Safari versions only grant it after a user gesture, so taps
 * retry too. Silently does nothing where the Screen Wake Lock API is unsupported.
 * @param {boolean} active
 */
export function useWakeLock(active) {
  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;

    let sentinel = null;
    let pending = false;
    let disposed = false;

    const acquire = async () => {
      if (disposed || sentinel || pending || document.visibilityState !== 'visible') return;
      pending = true;
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (disposed) {
          lock.release().catch(() => {});
          return;
        }
        sentinel = lock;
        lock.addEventListener('release', () => {
          if (sentinel === lock) sentinel = null;
        });
      } catch {
        // Denied (low battery, not visible, no gesture yet): try again on the next tap/show.
      } finally {
        pending = false;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') acquire();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('pointerdown', acquire, { passive: true });
    acquire();

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('pointerdown', acquire);
      sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, [active]);
}
