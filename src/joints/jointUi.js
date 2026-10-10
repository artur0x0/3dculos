/**
 * Joints on the feature strip, the shared sticky-pick card, and the
 * floating tags.
 *
 * The create card is `StickyPickApply`: sticky-pick 1–2 faces, lines, or
 * points, then a suggested property, then Confirm. The viewport and the
 * card share the rich pick list, the same way a contour shares its list,
 * because a joint fingerprint does not fit in the id/kind/label chip.
 * A placed joint is a floating tag. Tap it for Delete and X. That popup
 * does not reopen the card.
 *
 * Status is not stored. Undo is an in-memory snapshot of joints and
 * placements. A reload seeds one commit, so Undo starts empty and Redo
 * does not survive it. Scripts are never written here.
 */
import { nextNumberedName, serializeAssembly } from '../utils/assembly.js';
import { mintSurfId } from '../utils/git/surfId.js';
import { partPlacement } from '../utils/jointSchema.js';
import { worldPoint } from '../utils/partPose.js';
import { commitJointEdit } from './refreshJoints.js';

export const SAME_PART_MESSAGE = 'A joint needs two parts';
export const NO_SURF_ID_MESSAGE = 'This part has no surf id';

export const JOINT_TYPE_LABEL = Object.freeze({
  coincident: 'Coincident',
  concentric: 'Concentric',
  distance: 'Distance',
  angle: 'Angle',
  fixed: 'Fixed',
});

/** The shared pick-and-apply steps. `component` records which UI shipped. */
export const STICKY_PICK_CONTRACT = Object.freeze({
  component: 'StickyPickApply',
  picks: Object.freeze([1, 2]),
  kinds: Object.freeze(['face', 'edge', 'point']),
  then: 'suggested property',
  confirm: 'Confirm',
});

export function jointsChromeMounted({ appMode = 'cad', featureSession = false } = {}) {
  return appMode !== 'game' && !featureSession;
}

/** CAD strips show joints while no part is selected. */
export function cadStripsShowJoints(cadPartId) {
  return cadPartId == null;
}

/** Strip Undo walks joints only while no part is selected. */
export function stripUndoTarget(cadPartId) {
  return cadPartId == null ? 'joint' : 'part';
}

export function stripUndoLabel(cadPartId) {
  return stripUndoTarget(cadPartId) === 'joint' ? 'Undo joint' : 'Undo';
}

export function stripRedoLabel(cadPartId) {
  return stripUndoTarget(cadPartId) === 'joint' ? 'Redo joint' : 'Redo';
}

/**
 * An empty click clears the CAD part and the geometric selection.
 * The editor's active part stays.
 */
export function emptyClickCadSelection({
  cadPartId = null,
  activeId = null,
  featureSession = false,
} = {}) {
  if (featureSession) return { cadPartId, activeId, cleared: false };
  return { cadPartId: null, activeId, cleared: true };
}

/**
 * A face, edge, or point tap arms a joint only while the create card is
 * open. The Blocks button opens that card. With the card closed, the tap
 * selects the part. A body tap, a feature session, and game mode stay on
 * the normal selection path.
 */
export function shouldArmJointPick({
  featureSession = false,
  appMode = 'cad',
  kind = 'face',
  jointPicking = false,
} = {}) {
  if (!jointPicking) return false;
  if (appMode === 'game' || featureSession) return false;
  if (kind === 'body') return false;
  return kind === 'face' || kind === 'edge' || kind === 'point';
}

function hasAxis(pick) {
  return !!(pick && (pick.kind === 'axis' || pick.axis === true));
}

function planarFace(pick) {
  return !!(pick && pick.kind === 'face' && pick.planar !== false && !pick.axis);
}

export function typeFits(type, picks) {
  const list = Array.isArray(picks) ? picks : [];
  if (type === 'fixed') return list.length === 1 && !!list[0]?.surfId;
  if (list.length !== 2) return false;
  if (!list[0]?.surfId || !list[1]?.surfId) return false;
  if (list[0].surfId === list[1].surfId) return false;
  if (type === 'coincident' || type === 'distance') {
    return planarFace(list[0]) && planarFace(list[1]);
  }
  if (type === 'concentric') return hasAxis(list[0]) && hasAxis(list[1]);
  if (type === 'angle') {
    return list.every((pick) => (
      pick.kind === 'face' || pick.kind === 'edge' || pick.kind === 'axis'
    ));
  }
  return false;
}

/** Two planar faces suggest coincident. Two axes suggest concentric. Never fixed. */
export function suggestJointType(picks) {
  if (typeFits('coincident', picks)) return 'coincident';
  if (typeFits('concentric', picks)) return 'concentric';
  return null;
}

export function acceptJointPick(existing, pick) {
  const prior = Array.isArray(existing) ? existing.filter(Boolean) : [];
  if (!pick || !pick.surfId) {
    return { picks: prior, open: prior.length > 0, refuse: true, message: NO_SURF_ID_MESSAGE };
  }
  if (!prior.length) {
    return { picks: [pick], open: true, refuse: false, message: null };
  }
  if (prior[0].surfId === pick.surfId) {
    return { picks: prior, open: true, refuse: true, message: SAME_PART_MESSAGE };
  }
  return { picks: [prior[0], pick], open: true, refuse: false, message: null };
}

function kindWord(pick) {
  if (!pick) return '';
  if (pick.kind === 'edge') return 'line';
  if (pick.kind === 'axis') return 'axis';
  if (pick.kind === 'point') return 'point';
  return 'face';
}

/** Chip shown on StickyPickApply. The rich fingerprint stays on the pick. */
export function stickyJointPick(pick, index = 0) {
  const kind = pick?.kind || 'face';
  const word = kind === 'edge' ? 'line' : kind;
  const id = pick?.stickyId || `${pick?.surfId || 'part'}:${index}`;
  return {
    id: String(id),
    kind: String(kind),
    label: `${pick?.partName || 'Part'} · ${word}`,
  };
}

/** World point a floating tag sits on. Two references use their midpoint. */
export function jointTagAnchor(doc, joint) {
  const atOf = (ref) => {
    if (!ref?.part) return null;
    const part = (doc?.parts || []).find((row) => row?.surfId === ref.part);
    if (!part) return null;
    const local = ref.key?.at || [0, 0, 0];
    return worldPoint(local, partPlacement(part));
  };
  const a = atOf(joint?.a);
  const b = atOf(joint?.b);
  if (a && b) return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  return a || b || [0, 0, 0];
}

export function jointSubtitle(picks) {
  const list = Array.isArray(picks) ? picks : [];
  if (!list.length) return '';
  const side = (pick) => `${pick.partName || 'Part'} · ${kindWord(pick)}`;
  if (list.length === 1) return side(list[0]);
  return `${side(list[0])}  →  ${side(list[1])}`;
}

/**
 * `Coincident 1`. nextNumberedName allocates `Coincident (1)`; the card
 * shows that same slot without the parentheses.
 */
export function nextJointName(type, joints) {
  const label = JOINT_TYPE_LABEL[type] || 'Joint';
  const taken = [];
  for (const joint of joints || []) {
    const name = String(joint?.name || '');
    taken.push(name.replace(/ (\d+)$/, ' ($1)'));
  }
  const allocated = nextNumberedName(label, taken);
  return allocated.replace(/ \((\d+)\)$/, ' $1');
}

export function mintJointIdentity(type, joints, mint = mintSurfId) {
  return { id: mint(), name: nextJointName(type, joints) };
}

function storedKind(pick, type) {
  if (type === 'concentric' || pick.kind === 'axis' || pick.axis) return 'axis';
  if (pick.kind === 'edge') return 'edge';
  return 'face';
}

export function buildJointRecord(card, identity) {
  const picks = card?.picks || [];
  const type = card?.type;
  if (!typeFits(type, picks)) {
    return { ok: false, message: 'That joint does not fit these references' };
  }
  if (picks.some((pick) => !pick.surfId)) {
    return { ok: false, message: NO_SURF_ID_MESSAGE };
  }
  const name = String(card?.name || identity?.name || '').trim();
  const id = card?.id || identity?.id;
  if (!id || !name) return { ok: false, message: 'Name the joint' };
  const joint = { id, name, type };
  if (type === 'distance' || type === 'angle') {
    const value = Number(card.valueMm);
    if (!Number.isFinite(value)) return { ok: false, message: 'Enter a value' };
    joint.value = value;
    joint.sense = card.sense === -1 ? -1 : 1;
  }
  if (type === 'coincident') joint.opposed = card.opposed !== false;
  if (type === 'fixed') {
    joint.a = { part: picks[0].surfId };
    return { ok: true, joint };
  }
  const refOf = (pick) => ({
    part: pick.surfId,
    kind: storedKind(pick, type),
    key: pick.key,
  });
  joint.a = refOf(picks[0]);
  joint.b = refOf(picks[1]);
  return { ok: true, joint };
}

export function jointConfirmDisabled({ card, locked = false } = {}) {
  if (!card || locked) return true;
  if (!typeFits(card.type, card.picks)) return true;
  if (card.type === 'distance' || card.type === 'angle') {
    if (!Number.isFinite(Number(card.valueMm))) return true;
  }
  return false;
}

export function draftFromPicks(previous, picks, { joints = [] } = {}) {
  const suggested = suggestJointType(picks);
  const keepType = previous?.userPickedType && typeFits(previous.type, picks);
  const type = keepType ? previous.type : suggested;
  const identity = previous?.id
    ? { id: previous.id, name: previous.name }
    : (type ? mintJointIdentity(type, joints) : { id: null, name: '' });
  return {
    mode: 'create',
    id: identity.id,
    name: previous?.userNamed ? previous.name : (type ? nextJointName(type, joints) : (previous?.name || '')),
    picks,
    type,
    suggested,
    userPickedType: !!keepType,
    userNamed: !!previous?.userNamed,
    valueMm: previous?.valueMm,
    sense: previous?.sense === -1 ? -1 : 1,
    opposed: previous?.opposed !== false,
    note: previous?.note || '',
  };
}

export function cardFromJoint(joint, doc, message = '') {
  const nameOf = (surfId) => (
    (doc?.parts || []).find((part) => part.surfId === surfId)?.name || surfId
  );
  const pickOf = (ref) => {
    if (!ref) return null;
    return {
      surfId: ref.part,
      partName: nameOf(ref.part),
      kind: ref.kind || 'face',
      planar: ref.kind === 'face',
      axis: ref.kind === 'axis',
      key: ref.key,
    };
  };
  const picks = [pickOf(joint.a), pickOf(joint.b)].filter(Boolean);
  return {
    mode: 'edit',
    id: joint.id,
    name: joint.name,
    picks,
    type: joint.type,
    suggested: null,
    userPickedType: true,
    userNamed: true,
    valueMm: joint.value,
    sense: joint.sense === -1 ? -1 : 1,
    opposed: joint.opposed !== false,
    note: message || '',
  };
}

export function jointChipTitle(joint, status, message) {
  const name = joint?.name || 'Joint';
  if ((status === 'broken' || status === 'conflict') && message) return `${name} — ${message}`;
  return name;
}

export function jointChips(doc, live = {}) {
  return (doc?.joints || []).map((joint) => {
    const status = live.statuses?.[joint.id] || 'ok';
    const message = live.messages?.[joint.id] || (status === 'conflict' ? live.conflict : '');
    return {
      id: joint.id,
      name: joint.name,
      type: joint.type,
      status,
      title: jointChipTitle(joint, status, message),
      invalid: status === 'broken' || status === 'conflict',
    };
  });
}

/** X and Esc write nothing. The document is returned as the same object. */
export function dismissJointEdit(doc) {
  return doc;
}

export function applyJointCard({
  doc,
  scripts = null,
  card,
  action = 'confirm',
  locked = false,
  preempt = null,
  catalogs = null,
  joints = null,
} = {}) {
  if (action === 'delete') {
    return commitJointEdit({
      doc,
      scripts,
      action: 'delete',
      joint: { id: card?.id },
      locked,
      preempt,
      catalogs,
    });
  }
  if (locked) {
    return commitJointEdit({
      doc,
      scripts,
      action: 'confirm',
      joint: null,
      locked: true,
      preempt,
      catalogs,
    });
  }
  const identity = card?.id
    ? { id: card.id, name: card.name }
    : mintJointIdentity(card?.type, joints || doc?.joints || []);
  const built = buildJointRecord({ ...card, id: card?.id || identity.id, name: card?.name || identity.name }, identity);
  if (!built.ok) {
    return { ok: false, locked: false, doc, scripts, message: built.message, preempted: false };
  }
  const result = commitJointEdit({
    doc,
    scripts,
    action: 'confirm',
    joint: built.joint,
    locked: false,
    preempt,
    catalogs,
  });
  const status = result.statuses?.[built.joint.id];
  if (result.ok && (status === 'broken' || status === 'conflict')) {
    return {
      ok: false,
      locked: false,
      doc,
      scripts,
      message: result.messages?.[built.joint.id] || result.message || 'That joint does not fit these references',
      statuses: result.statuses,
      preempted: false,
    };
  }
  return result;
}

function snapshotOf(doc) {
  const placements = {};
  for (const part of doc?.parts || []) {
    if (!part?.surfId) continue;
    const pose = partPlacement(part);
    placements[part.surfId] = { t: pose.t.slice(), q: pose.q.slice() };
  }
  return {
    joints: JSON.parse(JSON.stringify(doc?.joints || [])),
    placements,
  };
}

/** One commit at the file's current joints and placements. Undo starts empty. */
export function seedAssemblyHistory(doc) {
  return { commits: [snapshotOf(doc)], head: 0 };
}

export function assemblyHistoryCanUndo(history) {
  return !!history && history.head > 0;
}

export function assemblyHistoryCanRedo(history) {
  return !!history && history.head < (history.commits?.length || 0) - 1;
}

/**
 * The tip becomes the live document, then the written document is one step.
 * A part-run solve that moved placements is the "before", not its own step.
 */
export function pushAssemblyHistory(history, beforeDoc, afterDoc) {
  const base = history?.commits ? history : seedAssemblyHistory(beforeDoc);
  const commits = base.commits.slice(0, base.head + 1);
  commits[commits.length - 1] = snapshotOf(beforeDoc);
  commits.push(snapshotOf(afterDoc));
  return { commits, head: commits.length - 1 };
}

export function undoAssemblyHistory(history) {
  if (!assemblyHistoryCanUndo(history)) return { history, snapshot: null };
  const head = history.head - 1;
  return { history: { ...history, head }, snapshot: history.commits[head] };
}

export function redoAssemblyHistory(history) {
  if (!assemblyHistoryCanRedo(history)) return { history, snapshot: null };
  const head = history.head + 1;
  return { history: { ...history, head }, snapshot: history.commits[head] };
}

export function applyAssemblySnapshot(doc, snapshot) {
  if (!doc || !snapshot) return doc;
  const parts = (doc.parts || []).map((part) => {
    const pose = snapshot.placements?.[part.surfId];
    if (!pose) return part;
    return { ...part, placement: { t: pose.t.slice(), q: pose.q.slice() } };
  });
  const joints = Array.isArray(snapshot.joints) && snapshot.joints.length
    ? snapshot.joints
    : undefined;
  return serializeAssembly({ ...doc, parts, joints });
}

/**
 * Strip Undo while no part is selected. Scripts are returned as the same
 * object. The part stacks are not an argument, so they cannot move.
 */
export function undoJointStrip({ history, doc, scripts }) {
  const step = undoAssemblyHistory(history);
  if (!step.snapshot) return { history, doc, scripts, changed: false };
  return {
    history: step.history,
    doc: applyAssemblySnapshot(doc, step.snapshot),
    scripts,
    changed: true,
  };
}

export function redoJointStrip({ history, doc, scripts }) {
  const step = redoAssemblyHistory(history);
  if (!step.snapshot) return { history, doc, scripts, changed: false };
  return {
    history: step.history,
    doc: applyAssemblySnapshot(doc, step.snapshot),
    scripts,
    changed: true,
  };
}

export function assemblyHistoryKey(doc) {
  const ids = (doc?.parts || []).map((part) => part?.surfId || part?.id || '').sort().join(',');
  return `${doc?.source || ''}\0${doc?.name || ''}\0${ids}`;
}
