/**
 * An erased account keeps its `users` row, anonymized: its name becomes this
 * English text and its email `deleted+<id>@deleted.invalid` (Step 9.5). The
 * text is stored, so it reads the same in exports and logs; whatever is shown
 * to people replaces it with `User.deletedUser` in the viewer's language
 * (`localizeDeletedUserNames`, run by `route()` on every JSON answer).
 */
export const DELETED_USER_NAME = "Deleted user";

export const DELETED_USER_EMAIL_DOMAIN = "@deleted.invalid";

export function isDeletedUserEmail(email: string | null | undefined): boolean {
  return Boolean(email && email.toLowerCase().endsWith(DELETED_USER_EMAIL_DOMAIN));
}

/** Keys under which the API carries a person's display name. */
const NAME_KEYS = new Set(["name", "displayName", "authorName", "actorName", "ownerName", "userName"]);

/**
 * Returns `value` with every person's name equal to `DELETED_USER_NAME`
 * replaced by `label`. Objects and arrays are copied only where something
 * changed; anything else is returned as is.
 */
export function localizeDeletedUserNames<T>(value: T, label: string): T {
  return walk(value, label, 0) as T;
}

function walk(value: unknown, label: string, depth: number): unknown {
  if (depth > 64 || value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = walk(item, label, depth + 1);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  const record = value as Record<string, unknown>;
  let copy: Record<string, unknown> | null = null;
  for (const [key, item] of Object.entries(record)) {
    const next =
      NAME_KEYS.has(key) && item === DELETED_USER_NAME ? label : walk(item, label, depth + 1);
    if (next !== item) {
      copy ??= { ...record };
      copy[key] = next;
    }
  }
  return copy ?? value;
}
