import React from 'react';
import FeatureSheet from '../FeatureSheet';
import { FeaResultsReadout, FeaRunBar, FeaStudyControls } from './FeaStudyControls';

/**
 * Analyze on the shared feature card (desktop). The same panel feeds the
 * phone card. The left tool rail is hidden here too, so fullLeft brings
 * the left edge to the pane inset. Setup stays in the body. After a solve,
 * the legend, the plot tabs, and Stage times scroll in the body. The footer
 * is Run, or Back to Setup. X and Esc close Analyze through FeatureSheet
 * onCancel. There is no Confirm.
 */
export function FeaStudyChip({ panel, compact = false }) {
  const results = panel.results === true;
  return (
    <FeatureSheet
      title="Analyze"
      subtitle={results ? '' : 'Fix a face, add a load, then Run.'}
      compact={compact}
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
