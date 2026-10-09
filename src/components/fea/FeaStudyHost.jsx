import React, { useEffect } from 'react';
import { FeaStudyChip } from './FeaStudyChip';
import { FeaStudySheet } from './FeaStudySheet';
import { useFeaStudy } from '../../fea/useFeaStudy.js';

/**
 * One owner for the study session. Phone and desktop both mount the
 * bottom card here, inside the viewport pane. Game leaves enabled false,
 * so this mounts no card.
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
  closeRef,
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
    if (!closeRef) return undefined;
    closeRef.current = close;
    return () => {
      closeRef.current = () => {};
    };
  }, [close, closeRef]);

  useEffect(() => {
    if (!pickRef) return undefined;
    pickRef.current = open ? pick : null;
    return () => {
      pickRef.current = null;
    };
  }, [open, pick, pickRef]);

  if (!open || !enabled) return null;
  if (compact) return <FeaStudySheet panel={panel} />;
  return <FeaStudyChip panel={panel} />;
}
