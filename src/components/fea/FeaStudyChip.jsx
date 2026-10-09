import React from 'react';
import FeatureSheet from '../FeatureSheet';
import { FeaRunBar, FeaStudyControls } from './FeaStudyControls';

/**
 * Analyze on the shared feature card (desktop). The same panel feeds the
 * phone card. Setup stays in the body. The footer is Run, or Back to Setup
 * after a solve. X and Esc close Analyze. There is no Confirm.
 */
export function FeaStudyChip({ panel, compact = false }) {
  const results = panel.results === true;
  return (
    <FeatureSheet
      title="Analyze"
      subtitle={results ? '' : 'Fix a face, add a load, then Run.'}
      compact={compact}
      onCancel={() => panel.close?.()}
      footer={<FeaRunBar panel={panel} />}
      cardAttrs={{
        'data-fea-sheet': '1',
        'data-fea-mode': '1',
        'data-fea-view': results ? 'results' : 'setup',
      }}
    >
      {results ? null : (
        <div className="mt-1.5 flex flex-col gap-1.5 font-sans">
          <FeaStudyControls panel={panel} />
        </div>
      )}
    </FeatureSheet>
  );
}
