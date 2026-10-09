/**
 * Vault name default and lazy backfill. No mongoose, express, or other
 * backend packages — unit tests load this file from a root `npm ci`.
 *
 * The schema default returns `surfcad-vault` only while the document is new.
 * Hydrate (`isNew === false`) returns nothing, so an existing user stays
 * unset and is not handed an empty vault. Resolution writes back the name
 * it actually adopts. Nothing here creates a GitHub repo.
 */
import {
  DEFAULT_VAULT_NAME,
  sanitizeVaultName,
  storedVaultNameFromUser,
} from '../../src/utils/git/vaultNames.js';

/** Mongoose schema default. `this` is the document. */
export function defaultVaultName() {
  return this?.isNew ? DEFAULT_VAULT_NAME : undefined;
}

/**
 * Apply the schema default the way mongoose does: a function that returns
 * `undefined` is not written onto the document.
 */
export function applyVaultNameDefault(user) {
  if (!user) return user;
  if (user.vaultName != null && String(user.vaultName).trim() !== '') return user;
  const filled = defaultVaultName.call(user);
  if (typeof filled !== 'undefined') user.vaultName = filled;
  return user;
}

/** New account. The default fills `vaultName` when the caller did not. */
export function newUserVaultRecord(fields = {}) {
  return applyVaultNameDefault({ ...fields, isNew: true });
}

/**
 * Existing document. `isNew` is false, so the default does not invent a name.
 * A stored `vaultName` in `fields` is kept.
 */
export function existingUserVaultRecord(fields = {}) {
  return applyVaultNameDefault({ ...fields, isNew: false });
}

/**
 * Lazy backfill. Stores the resolved GitHub repo name. An empty name leaves
 * the field unset. Idempotent when the stored name already matches.
 * Does not create or delete a repo.
 */
export function rememberResolvedVaultName(user, resolvedName) {
  const prev = storedVaultNameFromUser(user);
  const next = sanitizeVaultName(resolvedName);
  if (!user || !next) return { changed: false, vaultName: prev };
  if (prev === next) return { changed: false, vaultName: prev };
  user.vaultName = next;
  return { changed: true, vaultName: next };
}
