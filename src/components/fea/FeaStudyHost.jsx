import React, { useEffect } from 'react';
import { FeaStudyChip } from './FeaStudyChip';
import { FeaStudySheet } from './FeaStudySheet';
import { useFeaPanelSnapshot, useFeaStudy } from '../../fea/useFeaStudy.js';

/**
 * One owner for the study session. Desktop paints the bottom-centre chip.
 * A phone paints nothing here; App mounts FeaStudySheetGate in the
 * FeatureSheet slot and reads the same snapshot.
 */
export function FeaStudyHost({
  enabled = true,
  compact = false,
  paintOpen = false,
  script = '',
  getScript,
  onCommit,
  assemblyLocked,
  getSolid,
  onHighlight,
  onClaim,
  onActive,
  pickRef,
  toggleRef,
}) {
  const panel = useFeaStudy({
    enabled,
    compact,
    paintOpen,
    script,
    getScript,
    onCommit,
    assemblyLocked,
    getSolid,
    onHighlight,
    onClaim,
  });
  const open = panel.open;
  const close = panel.close;
  const toggle = panel.toggle;
  const pick = panel.pick;

  useEffect(() => {
    onActive?.(open);
  }, [onActive, open]);

  useEffect(() => {
    if (!toggleRef) return undefined;
    toggleRef.current = toggle;
    return () => {
      toggleRef.current = () => {};
    };
  }, [toggle, toggleRef]);

  useEffect(() => {
    if (!pickRef) return undefined;
    pickRef.current = open ? pick : null;
    return () => {
      pickRef.current = null;
    };
  }, [open, pick, pickRef]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open || compact) return null;
  return <FeaStudyChip panel={panel} compact={false} />;
}

/** Mobile FeatureSheet slot. Renders only while Analyze is open on a phone. */
export function FeaStudySheetGate({ mobile = false }) {
  const panel = useFeaPanelSnapshot();
  if (!mobile || !panel?.open) return null;
  return <FeaStudySheet panel={panel} />;
}
