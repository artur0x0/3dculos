import React from 'react';

/**
 * Assembly scope and the bonded pair list. Renders nothing for a one-part
 * study, so the single-part card stays the same. Pairs the user turns off
 * stay in the study with enabled false.
 */
export function FeaAssemblySetup({ panel }) {
  const parts = panel.assemblyParts || [];
  if (parts.length < 2) return null;
  const kind = panel.study?.scope?.kind;
  const assemblyOn = kind === 'assembly' || kind === 'parts';
  const selected = new Set(
    kind === 'parts'
      ? (panel.study?.scope?.ids || []).map((id) => String(id))
      : parts.map((part) => String(part.id)),
  );
  const nameOf = (id) => parts.find((part) => String(part.id) === String(id))?.name || id;
  const contacts = assemblyOn ? (panel.study?.contacts || []) : [];
  return (
    <div className="flex flex-col gap-1" data-fea-scope="">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-cyan-200/80">Study</span>
      <div className="flex gap-1">
        <button
          type="button"
          data-fea-scope-kind="part"
          aria-pressed={!assemblyOn}
          onClick={() => panel.setStudyScope?.({ kind: 'part' })}
          className={`rounded px-2 py-1 text-[13px] ${
            !assemblyOn
              ? 'bg-cyan-600 text-white'
              : 'border border-cyan-700/70 bg-cyan-950/80 text-cyan-100'
          }`}
        >
          This part
        </button>
        <button
          type="button"
          data-fea-scope-kind="assembly"
          aria-pressed={assemblyOn}
          onClick={() => panel.setStudyScope?.({ kind: 'assembly' })}
          className={`rounded px-2 py-1 text-[13px] ${
            assemblyOn
              ? 'bg-cyan-600 text-white'
              : 'border border-cyan-700/70 bg-cyan-950/80 text-cyan-100'
          }`}
        >
          Assembly
        </button>
      </div>
      {assemblyOn && parts.map((part) => (
        <label key={part.id} className="flex items-center gap-1.5 text-[12px] text-cyan-50" data-fea-scope-part={part.id}>
          <input
            type="checkbox"
            checked={selected.has(String(part.id))}
            onChange={() => panel.toggleScopePart?.(part.id)}
          />
          {part.name || part.id}
        </label>
      ))}
      {assemblyOn && contacts.map((contact, index) => (
        <label key={`${contact.a?.part}:${contact.a?.faceID}:${contact.b?.part}:${contact.b?.faceID}`} className="flex items-center gap-1.5 text-[12px] text-cyan-50" data-fea-contact="">
          <input
            type="checkbox"
            checked={contact.enabled !== false}
            onChange={() => panel.setContactEnabled?.(index, contact.enabled === false)}
          />
          {nameOf(contact.a?.part)} face {contact.a?.faceID} · {nameOf(contact.b?.part)} face {contact.b?.faceID}
        </label>
      ))}
      {assemblyOn && contacts.length === 0 && (
        <p className="text-[11px] text-cyan-100/80" data-fea-contact-empty="">No touching faces within the bond gap.</p>
      )}
    </div>
  );
}
