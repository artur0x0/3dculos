import { Trash2 } from 'lucide-react';
import VaultPickerDialog from './VaultPickerDialog';
import {
  PARTS_DIALOG_BTN_GHOST,
  PARTS_DIALOG_BTN_PRIMARY,
  PARTS_TEXT_INPUT_CLASS,
  PARTS_TEXT_INPUT_STYLE,
} from '../utils/partsChrome.js';

const ROW_TRASH = 'shrink-0 rounded p-1 text-gray-500 hover:bg-red-500/15 hover:text-red-300';
const DANGER_BTN = 'rounded-md bg-red-600 text-xs font-medium text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-red-600';

/**
 * One Open assembly row: the name opens it, the trash asks before delete.
 * Same control on the folder → Assembly list and the git open search.
 */
export function AssemblyOpenRow({
  name,
  label,
  current = false,
  onOpen,
  onDelete,
}) {
  return (
    <li className="flex items-center gap-1" data-git-open-assembly-row={name}>
      <button
        type="button"
        data-git-open-item={name}
        data-git-open-kind="assembly"
        data-git-open-current={current ? 'true' : undefined}
        className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left text-xs text-gray-100 hover:bg-white/10"
        onClick={() => onOpen?.(name)}
      >
        <span className="block truncate">{label || name}</span>
        {current ? <span className="text-[10px] text-gray-500">open now</span> : null}
      </button>
      <button
        type="button"
        data-assembly-delete={name}
        title={`Delete ${name}`}
        aria-label={`Delete assembly ${name}`}
        className={ROW_TRASH}
        onClick={(event) => {
          event.stopPropagation();
          onDelete?.(name);
        }}
      >
        <Trash2 size={14} />
      </button>
    </li>
  );
}

export function AssemblyOpenList({ items, current, onOpen, onDelete }) {
  return (
    <ul className="max-h-64 space-y-1 overflow-y-auto" data-git-open-list="">
      {(items || []).map((item) => (
        <AssemblyOpenRow
          key={item.name}
          name={item.name}
          label={item.label || item.name}
          current={item.name === current}
          onOpen={onOpen}
          onDelete={onDelete}
        />
      ))}
    </ul>
  );
}

/**
 * Delete assembly? Name, part count, parts other assemblies still use,
 * and two actions plus Cancel. Keep-parts leaves files in /parts and is
 * the primary. Deleting the part files stays disabled until the assembly
 * name is typed. A copy another assembly uses moves to /parts either way.
 */
export default function DeleteAssemblyDialog({
  assemblyName,
  partCount = 0,
  referenced = [],
  typed = '',
  loading = false,
  busy = false,
  error = '',
  onTyped,
  onKeep,
  onDrop,
  onClose,
}) {
  const count = Number(partCount) || 0;
  const countLabel = `${count} ${count === 1 ? 'part' : 'parts'}`;
  const confirmed = String(typed || '').trim() === assemblyName;
  const locked = loading || busy;
  return (
    <VaultPickerDialog
      title="Delete assembly?"
      labelledBy="assembly-delete-title"
      dataAttr="delete-assembly"
      onClose={locked ? undefined : onClose}
      footer={(
        <div className="mt-4 flex flex-col gap-2" data-assembly-delete-actions="">
          <button
            type="button"
            data-assembly-delete-keep=""
            className={`inline-flex h-10 w-full items-center justify-center ${PARTS_DIALOG_BTN_PRIMARY}`}
            disabled={locked}
            onClick={() => onKeep?.()}
          >
            Delete assembly, keep parts
          </button>
          <button
            type="button"
            data-assembly-delete-parts=""
            data-assembly-delete-parts-enabled={confirmed && !locked ? 'true' : 'false'}
            className={`inline-flex h-10 w-full items-center justify-center ${DANGER_BTN}`}
            disabled={locked || !confirmed}
            onClick={() => onDrop?.()}
          >
            Delete assembly and its parts
          </button>
          <button
            type="button"
            className={`inline-flex h-10 w-full items-center justify-center ${PARTS_DIALOG_BTN_GHOST}`}
            onClick={onClose}
            data-git-dialog-cancel=""
            disabled={locked}
          >
            Cancel
          </button>
        </div>
      )}
    >
      {loading && <p className="text-xs text-gray-400" data-git-dialog-loading="">Checking parts…</p>}
      {!loading && (
        <>
          <p className="text-xs text-gray-300" data-assembly-delete-summary="">
            <span className="font-medium text-gray-100" data-assembly-delete-name="">{assemblyName}</span>
            {' has '}
            <span data-assembly-delete-count={String(count)}>{countLabel}</span>
            .
          </p>
          <p className="mt-2 text-xs text-gray-400" data-assembly-delete-rules="">
            Keeping parts leaves files in /parts where they are. Deleting parts removes a script only when no other assembly uses it. A copy another assembly uses moves to /parts.
          </p>
          {referenced.length > 0 && (
            <div className="mt-3" data-assembly-delete-kept="">
              <p className="text-xs text-gray-200" data-assembly-delete-kept-heading="">
                These parts are used elsewhere and will be kept in /parts
              </p>
              <ul className="mt-1 max-h-32 space-y-1 overflow-y-auto">
                {referenced.map((part) => (
                  <li
                    key={part.path || part.name}
                    className="text-xs text-gray-300"
                    data-assembly-delete-kept-part={part.name}
                  >
                    <span className="text-gray-100">{part.name}</span>
                    <span className="text-gray-500" data-assembly-delete-kept-by="">
                      {` — ${(part.assemblies || []).join(', ')}`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <label className="mt-3 block text-xs text-gray-400" htmlFor="assembly-delete-confirm">
            {`Type ${assemblyName} to delete its parts`}
          </label>
          <input
            id="assembly-delete-confirm"
            data-assembly-delete-confirm-input=""
            className={`mt-1 ${PARTS_TEXT_INPUT_CLASS}`}
            style={PARTS_TEXT_INPUT_STYLE}
            value={typed}
            autoComplete="off"
            disabled={locked}
            onChange={(event) => onTyped?.(event.target.value)}
          />
        </>
      )}
      {error && (
        <p className="mt-2 text-xs text-amber-300" data-assembly-delete-error="">{error}</p>
      )}
    </VaultPickerDialog>
  );
}
