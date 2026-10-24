import { useEffect } from 'react';
import './controller.css';

const LOCK_CLASS = 'controller-locked';

const preventDefault = (event) => event.preventDefault();

/**
 * Turn the page into a fixed game controller while mounted: no scrolling, rubber-banding,
 * pull-to-refresh, pinch zoom, double-tap zoom, text selection or long-press callouts.
 * CSS (controller.css) does most of it; iOS Safari ignores user-scalable=no, so pinch
 * gestures and multi-finger moves are also cancelled here.
 */
export function useControllerLock() {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add(LOCK_CLASS);

    const onTouchMove = (event) => {
      // Range sliders and text fields still need to drag their own content.
      const target = event.target;
      if (event.touches.length < 2 && target instanceof Element && target.closest('input')) {
        return;
      }
      event.preventDefault();
    };

    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('gesturestart', preventDefault, { passive: false });
    document.addEventListener('gesturechange', preventDefault, { passive: false });
    document.addEventListener('gestureend', preventDefault, { passive: false });

    return () => {
      root.classList.remove(LOCK_CLASS);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('gesturestart', preventDefault);
      document.removeEventListener('gesturechange', preventDefault);
      document.removeEventListener('gestureend', preventDefault);
    };
  }, []);
}
