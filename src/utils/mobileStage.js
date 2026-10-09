/**
 * Phone landing stage. The bottom pill is CAD or Parts.
 * A saved Script stage, or a link that names script, opens Parts.
 * The editor itself opens from a part pencil (or Edit script).
 */

const STAGES = new Set(['cad', 'parts', 'script']);

function stageParam(raw) {
  const text = String(raw || '').replace(/^[?#]/, '');
  if (!text) return null;
  try {
    const stage = new URLSearchParams(text).get('stage');
    return STAGES.has(stage) ? stage : null;
  } catch {
    return null;
  }
}

/** `?stage=` or `#script` / `#stage=script`. Null when the link names no stage. */
export function linkedMobileStage(search = '', hash = '') {
  const fromSearch = stageParam(search);
  if (fromSearch) return fromSearch;
  const raw = String(hash || '').replace(/^#/, '');
  if (STAGES.has(raw)) return raw;
  return stageParam(hash);
}

/**
 * Landing stage for a stored mode and an optional link.
 * `script` is never the landing view — it opens Parts.
 * An explicit cad/parts/script link wins over the saved mode.
 */
export function landingMobileStage(stored, link = null) {
  const named = STAGES.has(link) ? link : stored;
  if (named === 'script' || named === 'parts') return 'parts';
  return 'cad';
}
