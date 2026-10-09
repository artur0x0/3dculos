import React from 'react';
import FeatureSheet from '../FeatureSheet';
import { FeaResultsReadout, FeaRunBar, FeaStudyControls } from './FeaStudyControls';

/**
 * Analyze on the shared feature card (phone). Docks at the pane bottom.
 * The stage switcher hides while this card is open. The left tool rail
 * is hidden too, so fullLeft brings the left edge to the pane inset.
 * Same body and footer as the desktop card. Stage times scroll in the
 * body so Back to Setup stays on screen. There is no Confirm.
 */
export function FeaStudySheet({ panel }) {
  const results = panel.results === true;
  return (
    <FeatureSheet
      title="Analyze"
      subtitle={results ? '' : 'Fix a face, add a load, then Run.'}
      compact
      fullLeft
      onCancel={() => panel.close?.()}
      footer={<FeaRunBar panel={panel} />}
      cardAttrs={{
        'data-fea-sheet': '1',
        'data-fea-mode': '1',
        'data-fea-view': results ? 'results' : 'setup',
      }}
    >
      {results ? (
        <FeaResultsReadout panel={panel} />
      ) : (
        <div className="mt-1.5 flex flex-col gap-1.5 font-sans">
          <FeaStudyControls panel={panel} />
        </div>
      )}
    </FeatureSheet>
  );
}
