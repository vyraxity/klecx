"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  Archive,
  ArrowLeft,
  ChevronRight,
  FolderInput,
  FolderKanban,
  Menu,
  MoreHorizontal,
  MessagesSquare,
  Pencil,
  Share2,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUiStore } from "@/lib/stores/ui";
import LocaleSwitcher from "@/components/layout/locale-switcher";
import type { SidebarProjectItem, SidebarWorkspaceItem } from "./types";
import { ShareAndPeopleDialog } from "@/components/workspace/ShareAndPeopleDialog";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { NotesPopover } from "@/components/workspace/notes-popover";
import { api } from "@/lib/api/client";
import {
  SETTINGS_RETURN_FALLBACK,
  settingsReturnHref,
  topbarPage,
} from "@/lib/layout/topbar-page";

export interface TopbarProps {
  /** The sidebar's entry for the workspace page being shown (null elsewhere, or when it isn't listed). */
  activeWorkspace: SidebarWorkspaceItem | null;
  currentUserId?: string;
  projects: SidebarProjectItem[];
  onRenameWorkspace: (workspaceId: string, title: string) => Promise<void>;
  onMoveWorkspace: (
    workspaceId: string,
    projectId: string | null,
  ) => Promise<void>;
  onArchiveWorkspace: (workspaceId: string) => Promise<void>;
  onRequestDeleteWorkspace: (workspace: SidebarWorkspaceItem) => void;
}

export function Topbar({
  activeWorkspace,
  currentUserId,
  projects,
  onRenameWorkspace,
  onMoveWorkspace,
  onArchiveWorkspace,
  onRequestDeleteWorkspace,
}: TopbarProps) {
  const t = useTranslations("AppShell");
  const tChat = useTranslations("Chat");
  const tThreads = useTranslations("Threads");
  const tCommon = useTranslations("Common");
  const pathname = usePathname();
  const mobileNavIsOpen = useUiStore((s) => s.mobileNavIsOpen);
  const toggleMobileNavOpen = useUiStore((s) => s.toggleMobileNavOpen);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const toggleRightPanelOpen = useUiStore((s) => s.toggleRightPanelOpen);
  const currentPageTitle = useUiStore((s) => s.currentPageTitle);
  const setCurrentPageTitle = useUiStore((s) => s.setCurrentPageTitle);

  const [isEditingTitle, setIsEditingTitle] = React.useState(false);
  const [draftTitle, setDraftTitle] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  const tSettings = useTranslations("Settings");
  const searchParams = useSearchParams();
  const page = React.useMemo(() => topbarPage(pathname), [pathname]);
  const onWorkspacePage = page.kind === "workspace";
  const workspacePageId = page.kind === "workspace" ? page.id : null;

  // On /projects/[id] the breadcrumb is "Projects › {project name}".
  const projectPageId = page.kind === "project" ? page.id : null;
  const projectPageName = projectPageId
    ? (projects.find((p) => p.id === projectPageId)?.name ?? "")
    : null;

  // The title comes from the page in the URL (pre-10.6 fix), never from the
  // last workspace opened.
  const displayedTitle =
    page.kind === "project"
      ? projectPageName || t("projects")
      : page.kind === "settings"
        ? tSettings("nav.title")
        : page.kind === "home"
          ? tChat("newChat")
          : page.kind === "workspace"
            ? activeWorkspace?.title || currentPageTitle || tChat("newChat")
            : currentPageTitle;

  // Settings' "Back to …" link: the last other page of the app, with its query
  // string (an open thread column), remembered as the person moves around.
  const settingsReturnTo = useUiStore((s) => s.settingsReturnTo);
  const setSettingsReturnTo = useUiStore((s) => s.setSettingsReturnTo);
  const search = searchParams?.toString() ?? "";
  const returnTitle =
    page.kind === "home" ? t("workspaces") : displayedTitle || t("workspaces");
  React.useEffect(() => {
    const href = settingsReturnHref(pathname ?? "", search);
    if (!href) return;
    const current = useUiStore.getState().settingsReturnTo;
    if (current?.href === href && current.title === returnTitle) return;
    setSettingsReturnTo({ href, title: returnTitle });
  }, [pathname, search, returnTitle, setSettingsReturnTo]);
  const backTarget = settingsReturnTo ?? {
    href: SETTINGS_RETURN_FALLBACK,
    title: t("workspaces"),
  };

  // The Comments & Asks badge: counted on the server, refreshed whenever a
  // comment or Ask changes ("annotation-changed") or the queue is answered.
  const queryClient = useQueryClient();
  const { data: annotationSummary } = useQuery({
    queryKey: ["workspaces", workspacePageId, "annotations", "summary"],
    queryFn: () =>
      api<{ comments: number; asks: number; total: number }>(
        `/api/v1/workspaces/${workspacePageId}/annotations?summary=1`
      ),
    enabled: Boolean(workspacePageId),
    staleTime: 30_000,
  });
  React.useEffect(() => {
    if (!workspacePageId) return;
    const refresh = () =>
      void queryClient.invalidateQueries({
        queryKey: ["workspaces", workspacePageId, "annotations", "summary"],
      });
    window.addEventListener("annotation-changed", refresh);
    return () => window.removeEventListener("annotation-changed", refresh);
  }, [queryClient, workspacePageId]);
  const annotationCount = annotationSummary?.total ?? 0;
  const annotationsLabel =
    annotationCount > 0
      ? tThreads("allAnnotationsCount", { count: annotationCount })
      : tThreads("allAnnotations");
  const projectName = React.useMemo(() => {
    if (!activeWorkspace?.projectId) return null;
    if (activeWorkspace.projectName) return activeWorkspace.projectName;
    return (
      projects.find((p) => p.id === activeWorkspace.projectId)?.name ?? null
    );
  }, [activeWorkspace, projects]);

  const startEditingTitle = () => {
    if (!activeWorkspace) return;
    setDraftTitle(displayedTitle);
    setIsEditingTitle(true);
  };

  React.useEffect(() => {
    if (isEditingTitle && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditingTitle]);

  const commitTitleEdit = async () => {
    if (!activeWorkspace) {
      setIsEditingTitle(false);
      return;
    }
    const trimmed = draftTitle.trim();
    setIsEditingTitle(false);
    if (!trimmed || trimmed === activeWorkspace.title) {
      setDraftTitle(activeWorkspace.title);
      return;
    }
    setCurrentPageTitle(trimmed);
    await onRenameWorkspace(activeWorkspace.id, trimmed);
  };

  const cancelTitleEdit = () => {
    setIsEditingTitle(false);
    setDraftTitle(displayedTitle);
  };

  const handleTitleKeyDown = async (
    e: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (e.key === "Enter") {
      e.preventDefault();
      await commitTitleEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelTitleEdit();
    }
  };

  const [shareOpen, setShareOpen] = React.useState(false);

  const handleShareClick = () => {
    if (!activeWorkspace || !currentUserId) return;
    setShareOpen(true);
  };

  return (
    <header data-testid="topbar" className="flex h-14 w-full shrink-0 items-center justify-between gap-2 border-b border-border bg-surface/85 px-3 sm:px-5 backdrop-blur-md z-20">
      {/* Left: Mobile Drawer Trigger + Project Breadcrumb + Inline-Editable Workspace Title */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="md:hidden shrink-0"
          aria-label={t("openNavigation")}
          aria-expanded={mobileNavIsOpen}
          onClick={() => toggleMobileNavOpen(true)}
        >
          <Menu className="h-4 w-4" strokeWidth={1.5} />
        </Button>

        <nav
          aria-label={tCommon("breadcrumb")}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-sm"
        >
          {page.kind === "settings" && (
            <>
              <Link
                href={backTarget.href}
                className="inline-flex min-w-0 max-w-36 sm:max-w-64 max-sm:min-h-11 max-sm:min-w-11 max-sm:justify-center items-center gap-1.5 rounded-md px-1.5 py-1 text-xs sm:text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="settings-back-link"
                title={t("backTo", { title: backTarget.title })}
              >
                <ArrowLeft className="h-4 w-4 sm:h-3.5 sm:w-3.5 shrink-0 rtl:rotate-180" strokeWidth={1.5} aria-hidden="true" />
                {/* Phones: the arrow alone, so "Settings" keeps the room. */}
                <span className="truncate max-sm:sr-only">{t("backTo", { title: backTarget.title })}</span>
              </Link>
              <span className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
            </>
          )}
          {projectPageName !== null ? (
            <>
              <span className="text-xs font-medium text-muted sm:text-sm">
                {t("projects")}
              </span>
              <ChevronRight
                className="h-3.5 w-3.5 shrink-0 text-subtle"
                strokeWidth={1.5}
                aria-hidden="true"
              />
            </>
          ) : (
            projectName &&
            activeWorkspace?.projectId && (
              <>
                <Link
                  href={`/projects/${activeWorkspace.projectId}`}
                  className="inline-flex max-w-36 sm:max-w-48 items-center gap-1.5 truncate rounded-md bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted transition-colors hover:bg-surface-3 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <FolderKanban
                    className="h-3.5 w-3.5 shrink-0 text-accent"
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                  <span className="truncate">{projectName}</span>
                </Link>
                <ChevronRight
                  className="h-3.5 w-3.5 shrink-0 text-subtle"
                  strokeWidth={1.5}
                  aria-hidden="true"
                />
              </>
            )
          )}

          {isEditingTitle && activeWorkspace ? (
            <input
              ref={inputRef}
              type="text"
              value={draftTitle}
              aria-label={t("editTitleLabel")}
              onChange={(e) => setDraftTitle(e.target.value)}
              onKeyDown={handleTitleKeyDown}
              onBlur={commitTitleEdit}
              maxLength={120}
              className="min-w-0 flex-1 max-w-md rounded-md border border-accent bg-surface px-2 py-1 text-sm font-semibold text-fg focus:outline-none focus:ring-2 focus:ring-ring"
            />
          ) : activeWorkspace ? (
            <button
              type="button"
              onClick={startEditingTitle}
              title={t("editTitleLabel")}
              className="group inline-flex min-w-0 max-w-md items-center gap-1.5 truncate rounded-md px-1.5 py-1 text-start text-sm sm:text-base font-semibold text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
            >
              <span className="truncate">{displayedTitle}</span>
              <Pencil
                className="h-3.5 w-3.5 shrink-0 text-subtle opacity-0 transition-opacity group-hover:opacity-100"
                strokeWidth={1.5}
                aria-hidden="true"
              />
            </button>
          ) : (
            <h1 className="truncate px-1.5 py-1 text-sm sm:text-base font-semibold text-fg">
              {displayedTitle}
            </h1>
          )}
        </nav>
      </div>

      {/* Right: workspace actions (workspace pages only), bell, language */}
      <div className="flex shrink-0 items-center gap-1.5">
        {activeWorkspace && currentUserId && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleShareClick}
            className="hidden sm:inline-flex"
          >
            <Share2 className="h-3.5 w-3.5" strokeWidth={1.5} />
            <span>{t("share")}</span>
          </Button>
        )}

        {onWorkspacePage && (
          <Button
            type="button"
            variant={rightPanelOpen ? "secondary" : "ghost"}
            size="icon"
            aria-label={annotationsLabel}
            aria-haspopup="dialog"
            aria-expanded={rightPanelOpen}
            tooltip={annotationsLabel}
            onClick={() => toggleRightPanelOpen()}
            className="relative"
          >
            <MessagesSquare className="h-4 w-4" strokeWidth={1.5} />
            {annotationCount > 0 && (
              <span
                aria-hidden="true"
                data-testid="annotations-count-badge"
                className="pointer-events-none absolute -top-0.5 -end-0.5 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-semibold leading-4 text-accent-fg"
              >
                {annotationCount > 99 ? t("countOverflow", { max: 99 }) : annotationCount}
              </span>
            )}
          </Button>
        )}

        {activeWorkspace && (
          <NotesPopover workspaceId={activeWorkspace.id} />
        )}

        {currentUserId && <NotificationBell />}

        <LocaleSwitcher compact saveToAccount />

        {activeWorkspace && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("workspaceOptions")}
                tooltip={t("workspaceOptions")}
              >
                <MoreHorizontal className="h-4 w-4" strokeWidth={1.5} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={startEditingTitle}>
                <Pencil className="h-4 w-4" strokeWidth={1.5} />
                <span>{t("rename")}</span>
              </DropdownMenuItem>

              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <FolderInput className="h-4 w-4" strokeWidth={1.5} />
                  <span>{t("moveToProject")}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-48">
                  <DropdownMenuItem
                    disabled={activeWorkspace.projectId === null}
                    onSelect={() => onMoveWorkspace(activeWorkspace.id, null)}
                  >
                    <span>{t("noProject")}</span>
                  </DropdownMenuItem>
                  {projects.map((proj) => (
                    <DropdownMenuItem
                      key={proj.id}
                      disabled={activeWorkspace.projectId === proj.id}
                      onSelect={() =>
                        onMoveWorkspace(activeWorkspace.id, proj.id)
                      }
                    >
                      <FolderKanban className="h-4 w-4" strokeWidth={1.5} />
                      <span className="truncate">{proj.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>

              <DropdownMenuItem onSelect={handleShareClick}>
                <Share2 className="h-4 w-4" strokeWidth={1.5} />
                <span>{t("share")}</span>
              </DropdownMenuItem>

              <DropdownMenuItem
                onSelect={() => onArchiveWorkspace(activeWorkspace.id)}
              >
                <Archive className="h-4 w-4" strokeWidth={1.5} />
                <span>{t("archive")}</span>
              </DropdownMenuItem>

              <DropdownMenuSeparator />

              <DropdownMenuItem
                className="text-danger focus:text-danger"
                onSelect={() => onRequestDeleteWorkspace(activeWorkspace)}
              >
                <Trash2 className="h-4 w-4" strokeWidth={1.5} />
                <span>{t("delete")}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {activeWorkspace && currentUserId && (
        <ShareAndPeopleDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          workspaceId={activeWorkspace.id}
          workspaceTitle={activeWorkspace.title}
          currentUserId={currentUserId}
        />
      )}
    </header>
  );
}

export default Topbar;
