import React from 'react';
import { useModalViewport } from '../hooks/useModalViewport.js';

/**
 * Overlay for the order-flow sheets. Caps the panel at the visible
 * viewport; the caller keeps its header and its own scrolling body.
 */
export default function ModalFit({
  className = '',
  cap,
  style,
  children,
  ...rest
}) {
  useModalViewport();
  const nextStyle = cap ? { ...style, '--modal-cap': cap } : style;
  return (
    <div
      data-modal-fit=""
      className={`modal-fit ${className}`.trim()}
      style={nextStyle}
      {...rest}
    >
      {children}
    </div>
  );
}
