import React from 'react';

/**
 * Slice Mobile B — iPhone Home Screen–style stage control.
 *
 * Bottom translucent glass pill. Three dots, in order: CAD, Script, Parts.
 * Tap a third to switch stage; session sticky via the caller
 * (`3dculos.mobileStage`). Desktop never mounts this.
 *
 * Future (NOT this PR): tapping the control invokes the AI prompt. An inert
 * center affordance (`data-ai-prompt-hook`) marks the wire-up site — do not
 * call PromptInput / AI from here.
 */
export default function MobileStageToggle({ stage = 'cad', onChange }) {
  const isCad = stage === 'cad';
  const isScript = stage === 'script';
  const isParts = stage === 'parts';

  const goCad = () => onChange?.('cad');
  const goScript = () => onChange?.('script');
  const goParts = () => onChange?.('parts');

  const dot = (on) => (
    on
      ? 'w-2.5 h-2.5 bg-white shadow'
      : 'w-2 h-2 bg-white/35'
  );

  return (
    <div
      className="pointer-events-auto flex justify-center"
      data-mobile-stage-toggle=""
      data-home-indicator=""
      role="group"
      aria-label="CAD, Script, or Parts"
      style={{ paddingBottom: 'max(8px, env(safe-area-inset-bottom, 0px))' }}
    >
      <div
        className="relative flex items-center justify-center rounded-full shadow-lg border border-white/20 bg-gray-900/55 surface-glass-chip"
        style={{ width: 168, height: 30 }}
        data-home-indicator-pill=""
      >
        <button
          type="button"
          data-stage-btn="cad"
          aria-label="CAD stage"
          aria-pressed={isCad}
          onClick={goCad}
          className="absolute inset-y-0 left-0 w-1/3 z-10 rounded-l-full active:bg-white/10"
        />
        <button
          type="button"
          data-stage-btn="script"
          aria-label="Script stage"
          aria-pressed={isScript}
          onClick={goScript}
          className="absolute inset-y-0 left-1/3 w-1/3 z-10 active:bg-white/10"
        />
        <button
          type="button"
          data-stage-btn="parts"
          aria-label="Parts stage"
          aria-pressed={isParts}
          onClick={goParts}
          className="absolute inset-y-0 right-0 w-1/3 z-10 rounded-r-full active:bg-white/10"
        />

        {/*
          Future AI prompt: center of this pill will invoke the AI prompt.
          Hook only — do NOT wire PromptInput / generate here (Slice B non-goal).
          `data-ai-prompt-hook` marks the inert center affordance for later.
        */}
        <span
          data-ai-prompt-hook=""
          aria-hidden="true"
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full z-[5] pointer-events-none"
          title="AI prompt (coming soon)"
        />

        <div
          className="relative z-[1] flex w-full items-center justify-between px-5 pointer-events-none"
          aria-hidden="true"
        >
          <span data-stage-dot="cad" className={`block rounded-full transition-all ${dot(isCad)}`} />
          <span data-stage-dot="script" className={`block rounded-full transition-all ${dot(isScript)}`} />
          <span data-stage-dot="parts" className={`block rounded-full transition-all ${dot(isParts)}`} />
        </div>
      </div>
    </div>
  );
}
