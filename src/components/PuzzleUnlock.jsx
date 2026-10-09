import React, { useEffect, useRef, useState } from 'react';
import { useAuthState } from '../hooks/useAuthState';
import {
  emptyPuzzleTaps,
  isStationaryTap,
  notePuzzleTap,
} from '../utils/puzzleUnlock';

const TOAST_MS = 3200;

/**
 * Hidden 44×44 corner of the CAD view.
 *
 * Placement: the square is the viewport's top-left (`top: 0`, `left: 0`,
 * `z-20`). The IO tray is gone, so this corner is the tap target. The
 * square is not shifted off the corner. The placement marker stays
 * `under-io-tray`.
 *
 * A tap calls stopPropagation and keeps pointer capture, so
 * TrackballControls (listening on the canvas) never sees it and the
 * camera does not orbit. Movement past 8px is a drag and is not counted.
 *
 * The hit target exists only while `useAuthState().signedIn` is true
 * (live `/me` session, including grey reauth). Signed-out and pending
 * sessions render nothing here: no toast, no puzzle, and the corner
 * still orbits.
 *
 * Five taps inside three seconds call `onUnlock` (App `handleStartGame`)
 * and show a short toast. The taps are not stored. Leaving the puzzle
 * starts over.
 */
export default function PuzzleUnlock({ enabled = true, onUnlock }) {
  const { signedIn } = useAuthState();
  const tapsRef = useRef(emptyPuzzleTaps());
  const originRef = useRef(null);
  const [toast, setToast] = useState(false);

  useEffect(() => {
    if (!toast) return undefined;
    const id = setTimeout(() => setToast(false), TOAST_MS);
    return () => clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    if (!signedIn) tapsRef.current = emptyPuzzleTaps();
  }, [signedIn]);

  const onPointerDown = (event) => {
    if (event.button != null && event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    originRef.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* capture is optional; the canvas still does not see this down */
    }
  };

  const onPointerUp = (event) => {
    const origin = originRef.current;
    if (!origin || origin.id !== event.pointerId) return;
    originRef.current = null;
    event.stopPropagation();
    if (!isStationaryTap(event.clientX - origin.x, event.clientY - origin.y)) return;
    const next = notePuzzleTap(tapsRef.current, {
      now: performance.now(),
      signedIn,
    });
    tapsRef.current = next.taps;
    if (!next.unlocked) return;
    setToast(true);
    onUnlock?.();
  };

  const onPointerCancel = (event) => {
    if (originRef.current?.id === event.pointerId) originRef.current = null;
  };

  return (
    <>
      {enabled && signedIn && (
        <button
          type="button"
          data-puzzle-unlock=""
          data-puzzle-unlock-placement="under-io-tray"
          data-puzzle-unlock-size="44"
          aria-hidden="true"
          tabIndex={-1}
          className="absolute left-0 top-0 z-20 cursor-default border-0 bg-transparent p-0 opacity-0"
          style={{ width: 44, height: 44, touchAction: 'manipulation' }}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        />
      )}
      {toast && (
        <div
          data-puzzle-unlock-toast=""
          role="status"
          className="pointer-events-none absolute top-36 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-cyan-400/50 bg-cyan-950/80 surface-glass-chip px-3 py-1.5 text-xs font-medium text-cyan-50 shadow-lg"
        >
          Puzzle unlocked
        </div>
      )}
    </>
  );
}
