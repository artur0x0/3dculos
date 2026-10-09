import React from 'react';
import FeatureSheet from '../FeatureSheet';
import { FeaRunBar, FeaStudyControls } from './FeaStudyControls';

/**
 * Analyze on the shared feature card (phone). Docks at the pane bottom.
 * The stage switcher hides while this card is open. Same body and footer
 * as the desktop card. There is no Confirm.
 */
export function FeaStudySheet({ panel }) {
  const results = panel.results === true;
  return (
    <FeatureSheet
      title="Analyze"
      subtitle={results ? '' : 'Fix a face, add a load, then Run.'}
      compact
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
