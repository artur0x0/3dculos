// components/ViewSnapControl.jsx — standard-view snap cluster for the lower toolbar.
//
// One Box button, two taps, no dead state:
//   1st tap  expands the cluster upward (Front / Right / Top appear above it)
//   2nd tap  snaps the camera to Isometric and closes the cluster
// The three popped-up buttons do the same for their own view: snap + auto-zoom.
// Any snap closes the cluster, so the next tap on Box starts fresh at "expand".
import React, { useState } from 'react';
import { Box, Square, PanelRight, PanelTop } from 'lucide-react';

// Left to right inside the popped-up bar.
const VIEWS = [
  { key: 'front', label: 'Snap to Front', Icon: Square },
  { key: 'right', label: 'Snap to Right', Icon: PanelRight },
  { key: 'top', label: 'Snap to Top', Icon: PanelTop },
];

const ViewSnapControl = ({ onSnap }) => {
  const [open, setOpen] = useState(false);

  const handleBox = () => {
    if (!open) {
      setOpen(true);                 // 1st tap: expand
    } else {
      onSnap?.('iso');               // 2nd tap: isometric...
      setOpen(false);                // ...and close the bar
    }
  };

  const handleSnap = (key) => {
    onSnap?.(key);
    setOpen(false);                  // a chosen view retires the cluster
  };

  return (
    <div className="relative flex">
      {open && (
        <div
          className="absolute bottom-full left-0 mb-2 flex gap-2 bg-white/60 backdrop-blur-sm p-2 rounded-lg shadow-lg"
          role="group"
          aria-label="Standard view snaps"
        >
          {VIEWS.map(({ key, label, Icon }) => (
            <button
              key={key}
              onClick={() => handleSnap(key)}
              className="p-2 rounded text-blue-600 hover:bg-blue-100"
              title={label}
              aria-label={label}
            >
              <Icon size={20} />
            </button>
          ))}
        </div>
      )}

      <button
        onClick={handleBox}
        className={`p-2 rounded ${open ? 'text-green-600 bg-green-100' : 'text-blue-600'} hover:bg-gray-100`}
        title={open ? 'Snap to Isometric (closes view snaps)' : 'Show view snaps (Front / Right / Top)'}
        aria-label="View snaps"
        aria-expanded={open}
      >
        <Box size={20} />
      </button>
    </div>
  );
};

export default ViewSnapControl;
