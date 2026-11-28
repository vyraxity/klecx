/**
 * Pre-10.6 fix: what the top bar shows comes from the URL only. Before, it
 * fell back to the last workspace opened, so Settings and other pages showed
 * that workspace's title, Share button, annotations panel and workspace menu
 * (which still acted on it).
 */
export type TopbarPage =
  | { kind: "workspace"; id: string }
  | { kind: "project"; id: string }
  | { kind: "settings" }
  | { kind: "home" }
  | { kind: "other" };

export function topbarPage(pathname: string | null | undefined): TopbarPage {
  const path = (pathname ?? "").replace(/\/+$/, "") || "/";
  const workspace = path.match(/^\/workspaces\/([^/]+)$/);
  if (workspace) return { kind: "workspace", id: decodeURIComponent(workspace[1]!) };
  const project = path.match(/^\/projects\/([^/]+)$/);
  if (project) return { kind: "project", id: decodeURIComponent(project[1]!) };
  if (path === "/settings" || path.startsWith("/settings/")) return { kind: "settings" };
  if (path === "/workspaces") return { kind: "home" };
  return { kind: "other" };
}

/** Where Settings' "Back to …" link goes when nothing was remembered (a reload, a link from an email). */
export const SETTINGS_RETURN_FALLBACK = "/workspaces";

/**
 * The page Settings' back link returns to: any page of the app shell except
 * Settings itself, with its query string (an open thread column, a filter).
 * Only same-origin paths are kept.
 */
export function settingsReturnHref(pathname: string, search: string): string | null {
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return null;
  if (topbarPage(pathname).kind === "settings") return null;
  const qs = search && search !== "?" ? (search.startsWith("?") ? search : `?${search}`) : "";
  return `${pathname}${qs}`;
}
