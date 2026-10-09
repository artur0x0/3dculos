/**
 * Fixed flight from a part thumbnail to the profile chip that is on screen.
 * Viewport chip above 768px. Parts ribbon chip at phone width.
 */
import React, { useEffect, useRef } from 'react';
import { useCartChrome } from '../hooks/useCart';

export default function CartDrop() {
  const cart = useCartChrome();
  const flight = cart?.flight;
  const nodeRef = useRef(null);
  const onDone = cart?.clearFlight;

  useEffect(() => {
    const el = nodeRef.current;
    if (!el || !flight) return undefined;
    const reduce = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (reduce) {
      onDone?.(flight.id);
      return undefined;
    }
    const dx = (flight.to.left + flight.to.width / 2) - (flight.from.left + flight.from.width / 2);
    const dy = (flight.to.top + flight.to.height / 2) - (flight.from.top + flight.from.height / 2);
    const anim = el.animate(
      [
        { transform: 'translate(0px, 0px) scale(1)', opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.28)`, opacity: 0.9 },
      ],
      { duration: 720, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' },
    );
    const finish = () => onDone?.(flight.id);
    anim.onfinish = finish;
    return () => {
      anim.cancel();
    };
  }, [flight, onDone]);

  if (!flight) return null;

  return (
    <div
      ref={nodeRef}
      data-cart-flight=""
      data-cart-flight-phase="run"
      className="pointer-events-none fixed z-[90] overflow-hidden rounded-md border border-white/20 shadow-lg"
      style={{
        left: flight.from.left,
        top: flight.from.top,
        width: flight.from.width,
        height: flight.from.height,
      }}
    >
      {flight.image ? (
        <img src={flight.image} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="h-full w-full bg-emerald-900/80" />
      )}
    </div>
  );
}
