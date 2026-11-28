/**
 * Pre-10.6 fix PR 8: Settings → Deleted & archived has two tabs. A link can
 * open the Archived one directly: `/settings/deleted?tab=archived`.
 */
export const DELETED_PAGE_TABS = ["deleted", "archived"] as const;
export type DeletedPageTab = (typeof DELETED_PAGE_TABS)[number];

export const DELETED_PAGE_HREF = "/settings/deleted";
export const ARCHIVED_PAGE_HREF = "/settings/deleted?tab=archived";

/** The tab a `?tab=` value opens (anything unknown opens "deleted"). */
export function deletedPageTab(value: string | string[] | null | undefined): DeletedPageTab {
  const v = Array.isArray(value) ? value[0] : value;
  return v === "archived" ? "archived" : "deleted";
}
