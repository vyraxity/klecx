import "server-only";
import { log, errInfo } from "@/server/log";

import { strToU8, zipSync, type Zippable } from "fflate";
import { createTranslator } from "use-intl/core";
import { db } from "@/server/db/client";
import { ApiError, Errors } from "@/server/http/errors";
import type { Actor } from "@/server/auth/session";
import { getStorageProvider, storagePath, type StorageResourceType } from "@/server/storage";
import { sendEmail } from "@/server/email/send";
import { messagesFor, resolveLocaleCode } from "@/i18n/messages";
import { listCreditHistory } from "@/server/services/usage";
import { creditHistoryCsv } from "@/server/services/usage-csv";

/**
 * Step 9.5: "Download your data" (Settings → Your data).
 *
 * One export per 24 hours. The ZIP is built in the background after the
 * request (`buildDataExport`, run with `after()`), stored privately under
 * `<CLOUDINARY_UPLOAD_FOLDER>/exports/<userId>/<id>` and downloadable by its
 * owner, signed in, for 24 hours; an email says when it's ready. Expired
 * files are deleted the next time the person opens Your data (and by the
 * Step 10.3 clean-up job).
 *
 * Contents (owner, 2026-11-23: files included up to 100 MB in total, the rest
 * listed in `files-not-included.txt`):
 * - `account.json` — profile, preferences, sign-in methods, sessions,
 *   subscription, billing consents, credit balance.
 * - `credits.csv` — the full credit history (as on the Usage page).
 * - `projects.json` — projects they own and the ones they're a member of.
 * - `workspaces/<n>-<title>/` for each workspace they own (deleted ones
 *   included while they can still be restored): `workspace.json` (members,
 *   Klecx notes, share links without their tokens, ownership-transfer
 *   history), `conversation.md` (every prompt, every version, every saved
 *   edit, sources), `annotations.json` (comments and Ask threads at every
 *   depth, with their messages and mentions; other members' private threads
 *   left out), `documents/` (generated and uploaded documents, every
 *   revision) and `files/` (the original files).
 * - `contributions.json` — what they did in other people's workspaces:
 *   prompts with their answers, their comments and Ask threads, messages,
 *   Klecx notes.
 * - `mentions.json`, `notifications.json`, `ownership-transfers.json`,
 *   `support/` (requests and screenshots).
 */
export const EXPORT_FILES_BUDGET_BYTES = 100 * 1024 * 1024;
export const EXPORT_DOWNLOAD_HOURS = 24;
const EXPORT_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A build that hasn't finished after this is treated as failed (the function was cut off). */
const EXPORT_STALE_MS = 15 * 60 * 1000;

type T = (key: string, values?: Record<string, unknown>) => string;

export interface DataExportDto {
  id: string;
  status: "PENDING" | "READY" | "FAILED" | "EXPIRED";
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
  bytes: number | null;
  filesIncluded: number;
  filesSkipped: number;
}

export interface DataExportOverview {
  exports: DataExportDto[];
  /** When the next export can be requested (null = now). */
  nextAllowedAt: string | null;
}

function toDto(e: {
  id: string;
  status: "PENDING" | "READY" | "FAILED";
  createdAt: Date;
  finishedAt: Date | null;
  expiresAt: Date | null;
  bytes: number | null;
  filesIncluded: number;
  filesSkipped: number;
}, now: Date): DataExportDto {
  let status: DataExportDto["status"] = e.status;
  if (e.status === "READY" && e.expiresAt && e.expiresAt <= now) status = "EXPIRED";
  if (e.status === "PENDING" && now.getTime() - e.createdAt.getTime() > EXPORT_STALE_MS) status = "FAILED";
  return {
    id: e.id,
    status,
    createdAt: e.createdAt.toISOString(),
    finishedAt: e.finishedAt?.toISOString() ?? null,
    expiresAt: e.expiresAt?.toISOString() ?? null,
    bytes: e.bytes,
    filesIncluded: e.filesIncluded,
    filesSkipped: e.filesSkipped,
  };
}

/** Deletes the files of expired exports (the rows stay as history). */
async function cleanUpExpired(userId: string, now: Date) {
  const expired = await db.dataExport.findMany({
    where: { userId, storageId: { not: null }, expiresAt: { lte: now } },
    select: { id: true, storageId: true },
  });
  for (const e of expired) {
    await getStorageProvider()
      .delete(e.storageId!, { resourceType: "raw" })
      .catch(() => false);
    await db.dataExport.update({ where: { id: e.id }, data: { storageId: null } });
  }
}

async function nextAllowedAt(userId: string, now: Date): Promise<Date | null> {
  const recent = await db.dataExport.findFirst({
    where: {
      userId,
      createdAt: { gt: new Date(now.getTime() - EXPORT_INTERVAL_MS) },
      OR: [
        { status: "READY" },
        { status: "PENDING", createdAt: { gt: new Date(now.getTime() - EXPORT_STALE_MS) } },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return recent ? new Date(recent.createdAt.getTime() + EXPORT_INTERVAL_MS) : null;
}

export async function getDataExports(userId: string, now: Date = new Date()): Promise<DataExportOverview> {
  await cleanUpExpired(userId, now);
  const rows = await db.dataExport.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  const next = await nextAllowedAt(userId, now);
  return { exports: rows.map((r) => toDto(r, now)), nextAllowedAt: next?.toISOString() ?? null };
}

/** Starts an export (one per 24 hours; a failed one doesn't count). The caller builds it in the background. */
export async function requestDataExport(actor: Actor, now: Date = new Date()): Promise<DataExportDto> {
  const next = await nextAllowedAt(actor.userId, now);
  if (next && next > now) {
    throw new ApiError(429, "export_limit", "You can request one export per day", {
      nextAllowedAt: next.toISOString(),
    });
  }
  const row = await db.dataExport.create({ data: { userId: actor.userId } });
  return toDto(row, now);
}

/** The language the person chose for the app (used for the export's texts and email). */
export async function savedUiLocale(userId: string): Promise<string | undefined> {
  const pref = await db.userPreference.findUnique({ where: { userId }, select: { uiLocale: true } });
  return pref?.uiLocale ?? undefined;
}

/** A short-lived signed link to the ZIP, for its owner only, while it's valid. */
export async function getDataExportDownloadUrl(actor: Actor, exportId: string, now: Date = new Date()): Promise<string> {
  const row = await db.dataExport.findUnique({ where: { id: exportId } });
  if (!row || row.userId !== actor.userId) throw Errors.notFound("Export");
  if (row.status !== "READY" || !row.storageId || !row.expiresAt || row.expiresAt <= now) {
    throw new ApiError(410, "export_expired", "This export is no longer available");
  }
  return getStorageProvider().privateUrl(row.storageId, { resourceType: "raw", expiresInSeconds: 300, format: "zip" });
}

// ---------------------------------------------------------------------------
// Building the ZIP

const json = (value: unknown) => strToU8(JSON.stringify(value, null, 2));
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

/** A safe, readable folder or file name. */
export function slugName(name: string, fallback: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._ -]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
  return cleaned || fallback;
}

function extensionOf(name: string, mime: string): string {
  const fromName = name.match(/\.([A-Za-z0-9]{1,8})$/)?.[1];
  if (fromName) return fromName.toLowerCase();
  return mime.split("/")[1]?.split(/[;+]/)[0] ?? "bin";
}

interface FileJob {
  path: string;
  providerId: string;
  resourceType: string;
  bytes: number;
  label: string;
}

class FileCollector {
  private used = 0;
  readonly included: string[] = [];
  readonly skipped: string[] = [];
  constructor(private readonly budget: number) {}

  async add(zip: Zippable, job: FileJob) {
    if (this.used + job.bytes > this.budget) {
      this.skipped.push(job.label);
      return;
    }
    try {
      const buf = await getStorageProvider().downloadBuffer(job.providerId, {
        resourceType: job.resourceType as StorageResourceType,
      });
      this.used += buf.byteLength;
      // Files are usually compressed already: store them as they are.
      zip[job.path] = [new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), { level: 0 }];
      this.included.push(job.path);
    } catch {
      this.skipped.push(job.label);
    }
  }
}

function uniquePath(used: Set<string>, base: string, ext: string): string {
  let path = `${base}.${ext}`;
  for (let n = 2; used.has(path); n++) path = `${base}-${n}.${ext}`;
  used.add(path);
  return path;
}

async function buildAccount(userId: string) {
  const [user, prefs, accounts, sessions, sub, consents, credit] = await Promise.all([
    db.user.findUniqueOrThrow({
      where: { id: userId },
      // Two-factor: only whether it is on; never the secret or the backup codes.
      select: { id: true, name: true, email: true, emailVerified: true, username: true, twoFactorEnabled: true, createdAt: true },
    }),
    db.userPreference.findUnique({ where: { userId } }),
    db.account.findMany({ where: { userId }, select: { providerId: true, createdAt: true } }),
    db.session.findMany({
      where: { userId },
      select: { createdAt: true, updatedAt: true, expiresAt: true, userAgent: true, ipAddress: true },
    }),
    db.subscription.findUnique({
      where: { userId },
      select: { plan: true, interval: true, status: true, cancelAtPeriodEnd: true, currentPeriodStart: true, currentPeriodEnd: true, createdAt: true },
    }),
    db.billingConsent.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
    db.creditAccount.findUnique({ where: { userId }, select: { planBalance: true, topupBalance: true } }),
  ]);
  const preferences = prefs ? Object.fromEntries(Object.entries(prefs).filter(([k]) => k !== "userId")) : null;
  return {
    exportedAt: new Date().toISOString(),
    profile: { ...user, createdAt: iso(user.createdAt) },
    preferences,
    signInMethods: accounts.map((a) => ({ method: a.providerId, connectedAt: iso(a.createdAt) })),
    sessions,
    subscription: sub,
    billingConsents: consents.map((c) => Object.fromEntries(Object.entries(c).filter(([k]) => k !== "userId"))),
    credits: credit ? { planBalance: credit.planBalance, topupBalance: credit.topupBalance } : null,
  };
}

async function buildCreditsCsv(userId: string, t: T): Promise<string | null> {
  const account = await db.creditAccount.findUnique({ where: { userId }, select: { id: true } });
  if (!account) return null;
  const entries = [];
  let cursor: string | undefined;
  for (let page = 0; page < 200; page++) {
    const res = await listCreditHistory(userId, { cursor, limit: 1000 });
    entries.push(...res.entries);
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return creditHistoryCsv(entries, t);
}

type Msg = {
  id: string;
  role: string;
  content: string;
  authorId: string | null;
  modelKey: string | null;
  citations: unknown;
  createdAt: Date;
  mentions: { userId: string | null; isKlecx: boolean; isAll: boolean }[];
  author: { name: string } | null;
};

const messageOut = (m: Msg) => ({
  id: m.id,
  role: m.role,
  author: m.role === "ASSISTANT" ? "Klecx" : m.author?.name ?? null,
  authorId: m.authorId,
  model: m.modelKey,
  content: m.content,
  sources: m.citations ?? null,
  mentions: m.mentions.map((x) => (x.isKlecx ? "@klecx" : x.isAll ? "@all" : x.userId)),
  createdAt: iso(m.createdAt),
});

const annotationInclude = {
  messages: {
    orderBy: { createdAt: "asc" as const },
    include: { mentions: { select: { userId: true, isKlecx: true, isAll: true } }, author: { select: { name: true } } },
  },
  createdBy: { select: { name: true } },
};

type AnnotationRow = Awaited<ReturnType<typeof loadAnnotations>>[number];

function loadAnnotations(where: object) {
  return db.annotation.findMany({
    where: { deletedAt: null, ...where },
    orderBy: [{ depth: "asc" }, { createdAt: "asc" }],
    include: annotationInclude,
  });
}

const annotationOut = (a: AnnotationRow) => ({
  id: a.id,
  kind: a.kind,
  by: a.authorType === "AI" ? "Klecx" : a.createdBy.name,
  visibility: a.visibility,
  depth: a.depth,
  parentAnnotationId: a.parentAnnotationId,
  on: {
    type: a.targetType,
    responseId: a.responseId,
    versionId: a.versionId,
    messageId: a.targetMessageId,
    documentId: a.documentId,
    documentRevision: a.documentRevision,
    editRevision: a.editRevision,
  },
  passage: a.anchorExact,
  questionState: a.questionState,
  suggestion: a.suggestion ?? null,
  suggestionState: a.suggestionState,
  resolvedAt: iso(a.resolvedAt),
  createdAt: iso(a.createdAt),
  messages: a.messages.map(messageOut),
});

function conversationMarkdown(
  title: string,
  responses: {
    id: string;
    prompt: string;
    kind: string;
    createdAt: Date;
    deletedAt: Date | null;
    quote: string | null;
    versions: {
      number: number;
      status: string;
      modelKey: string;
      content: string;
      createdAt: Date;
      edits: { revision: number; content: string; createdAt: Date }[];
      citations: { index: number; url: string; title: string | null }[];
    }[];
  }[]
): string {
  const out: string[] = [`# ${title}`, ""];
  for (const r of responses) {
    out.push(`## ${r.createdAt.toISOString()}${r.deletedAt ? " (deleted)" : ""}`, "");
    if (r.quote) out.push(...r.quote.split("\n").map((l) => `> ${l}`), "");
    out.push("**Prompt**", "", r.prompt || "(none)", "");
    for (const v of r.versions) {
      out.push(`### Version ${v.number} · ${v.modelKey} · ${v.createdAt.toISOString()}${v.status !== "COMPLETE" ? ` · ${v.status}` : ""}`, "");
      out.push(v.content || "(empty)", "");
      if (v.citations.length) {
        out.push("Sources:", ...v.citations.map((c) => `[${c.index}] ${c.title ? `${c.title} — ` : ""}${c.url}`), "");
      }
      for (const e of v.edits) {
        out.push(`#### Edit ${e.revision} · ${e.createdAt.toISOString()}`, "", e.content, "");
      }
    }
    out.push("---", "");
  }
  return out.join("\n");
}

const responseInclude = {
  versions: {
    orderBy: { number: "asc" as const },
    include: {
      edits: { orderBy: { revision: "asc" as const }, select: { revision: true, content: true, createdAt: true } },
      citations: { orderBy: { index: "asc" as const }, select: { index: true, url: true, title: true } },
    },
  },
};

async function addWorkspace(zip: Zippable, folder: string, ws: { id: string; title: string }, userId: string, files: FileCollector) {
  const [full, responses, annotations, documents, attachments] = await Promise.all([
    db.workspace.findUniqueOrThrow({
      where: { id: ws.id },
      select: {
        id: true,
        title: true,
        projectId: true,
        createdAt: true,
        archivedAt: true,
        deletedAt: true,
        members: { select: { role: true, createdAt: true, suspendedAt: true, user: { select: { name: true } } } },
        notes: { where: { deletedAt: null }, select: { quote: true, instruction: true, status: true, createdAt: true, createdBy: { select: { name: true } } } },
        shareLinks: { select: { scope: true, responseId: true, view: true, expiresAt: true, revokedAt: true, createdAt: true, viewCount: true } },
        ownershipTransfers: { select: { status: true, createdAt: true, respondedAt: true, fromUser: { select: { name: true } }, toUser: { select: { name: true } } } },
      },
    }),
    db.response.findMany({ where: { workspaceId: ws.id }, orderBy: { sortAt: "asc" }, include: responseInclude }),
    // Other members' private threads stay private.
    loadAnnotations({ workspaceId: ws.id, OR: [{ visibility: "WORKSPACE" }, { createdById: userId }] }),
    db.document.findMany({
      where: { workspaceId: ws.id },
      include: { revisions: { orderBy: { revision: "asc" }, select: { revision: true, content: true, createdAt: true, editorId: true } } },
    }),
    db.attachment.findMany({
      where: { workspaceId: ws.id, status: "READY", deletedAt: null },
      select: { providerId: true, resourceType: true, mime: true, bytes: true, originalName: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  zip[`${folder}/workspace.json`] = json({
    id: full.id,
    title: full.title,
    projectId: full.projectId,
    createdAt: iso(full.createdAt),
    archivedAt: iso(full.archivedAt),
    deletedAt: iso(full.deletedAt),
    members: full.members.map((m) => ({ name: m.user.name, role: m.role, since: iso(m.createdAt), suspended: Boolean(m.suspendedAt) })),
    klecxNotes: full.notes.map((n) => ({ by: n.createdBy.name, instruction: n.instruction, passage: n.quote, status: n.status, createdAt: iso(n.createdAt) })),
    shareLinks: full.shareLinks,
    ownershipTransfers: full.ownershipTransfers.map((t) => ({ from: t.fromUser.name, to: t.toUser.name, status: t.status, createdAt: iso(t.createdAt), respondedAt: iso(t.respondedAt) })),
  });
  zip[`${folder}/conversation.md`] = strToU8(conversationMarkdown(full.title, responses));
  zip[`${folder}/annotations.json`] = json(annotations.map(annotationOut));

  const used = new Set<string>();
  for (const d of documents) {
    const base = `${folder}/documents/${slugName(d.title, "document")}`;
    for (const r of d.revisions) {
      zip[uniquePath(used, `${base}-r${r.revision}`, "md")] = strToU8(r.content);
    }
  }
  for (const r of responses.filter((x) => x.kind === "DOCUMENT")) {
    const active = r.versions.at(-1);
    if (active) zip[uniquePath(used, `${folder}/documents/${slugName(r.prompt, "uploaded-document")}`, "md")] = strToU8(active.edits.at(-1)?.content ?? active.content);
  }
  const fileNames = new Set<string>();
  for (const a of attachments) {
    const base = slugName(a.originalName.replace(/\.[A-Za-z0-9]{1,8}$/, ""), "file");
    await files.add(zip, {
      path: uniquePath(fileNames, `${folder}/files/${base}`, extensionOf(a.originalName, a.mime)),
      providerId: a.providerId,
      resourceType: a.resourceType,
      bytes: a.bytes,
      label: `${full.title} — ${a.originalName}`,
    });
  }
}

async function buildContributions(userId: string) {
  const elsewhere = { workspace: { ownerId: { not: userId } } };
  const [responses, annotations, messages, notes] = await Promise.all([
    db.response.findMany({
      where: { createdById: userId, ...elsewhere },
      orderBy: { createdAt: "asc" },
      include: { ...responseInclude, workspace: { select: { title: true } } },
    }),
    loadAnnotations({ createdById: userId, ...elsewhere }),
    db.annotationMessage.findMany({
      where: { authorId: userId, annotation: { createdById: { not: userId }, deletedAt: null, ...elsewhere } },
      orderBy: { createdAt: "asc" },
      include: { mentions: { select: { userId: true, isKlecx: true, isAll: true } }, author: { select: { name: true } }, annotation: { select: { id: true, workspace: { select: { title: true } } } } },
    }),
    db.workspaceNote.findMany({
      where: { createdById: userId, deletedAt: null, ...elsewhere },
      select: { instruction: true, quote: true, status: true, createdAt: true, workspace: { select: { title: true } } },
    }),
  ]);
  return {
    prompts: responses.map((r) => ({
      workspace: r.workspace.title,
      prompt: r.prompt,
      createdAt: iso(r.createdAt),
      versions: r.versions.map((v) => ({ number: v.number, model: v.modelKey, content: v.content, edits: v.edits })),
    })),
    threads: annotations.map((a) => ({ ...annotationOut(a), workspaceId: a.workspaceId })),
    messagesInOtherThreads: messages.map((m) => ({ ...messageOut(m), annotationId: m.annotation.id, workspace: m.annotation.workspace.title })),
    klecxNotes: notes.map((n) => ({ workspace: n.workspace.title, instruction: n.instruction, passage: n.quote, status: n.status, createdAt: iso(n.createdAt) })),
  };
}

/** Builds the ZIP for `exportId` (idempotent: only a PENDING export is built). */
export async function buildDataExport(exportId: string, opts: { locale?: string } = {}): Promise<void> {
  const row = await db.dataExport.findUnique({ where: { id: exportId }, include: { user: { select: { email: true, deletedAt: true } } } });
  if (!row || row.status !== "PENDING" || row.user.deletedAt) return;
  const userId = row.userId;
  try {
    const locale = resolveLocaleCode(opts.locale);
    const t = createTranslator({ locale, messages: messagesFor(locale) }) as unknown as T;
    const zip: Zippable = {};
    const files = new FileCollector(EXPORT_FILES_BUDGET_BYTES);

    zip["account.json"] = json(await buildAccount(userId));
    const csv = await buildCreditsCsv(userId, t);
    if (csv) zip["credits.csv"] = strToU8(csv);

    const [projects, memberships, workspaces] = await Promise.all([
      db.project.findMany({ where: { ownerId: userId }, select: { id: true, name: true, description: true, createdAt: true, archivedAt: true, deletedAt: true } }),
      db.projectMember.findMany({ where: { userId }, select: { role: true, createdAt: true, project: { select: { id: true, name: true } } } }),
      db.workspace.findMany({ where: { ownerId: userId }, select: { id: true, title: true }, orderBy: { createdAt: "asc" } }),
    ]);
    zip["projects.json"] = json({
      owned: projects,
      memberOf: memberships.map((m) => ({ id: m.project.id, name: m.project.name, role: m.role, since: iso(m.createdAt) })),
    });

    for (const [i, ws] of workspaces.entries()) {
      const folder = `workspaces/${String(i + 1).padStart(3, "0")}-${slugName(ws.title, "workspace")}`;
      await addWorkspace(zip, folder, ws, userId, files);
    }

    zip["contributions.json"] = json(await buildContributions(userId));

    const [mentions, notifications, transfers, tickets] = await Promise.all([
      db.annotationMention.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true, message: { select: { annotation: { select: { id: true, workspace: { select: { title: true } } } } } } },
      }),
      db.notification.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, select: { type: true, payload: true, status: true, createdAt: true, readAt: true } }),
      db.ownershipTransfer.findMany({
        where: { OR: [{ fromUserId: userId }, { toUserId: userId }] },
        orderBy: { createdAt: "asc" },
        select: { status: true, createdAt: true, respondedAt: true, workspace: { select: { title: true } }, project: { select: { name: true } }, fromUser: { select: { name: true } }, toUser: { select: { name: true } } },
      }),
      db.supportTicket.findMany({
        where: { OR: [{ userId }, { email: { equals: row.user.email, mode: "insensitive" } }] },
        orderBy: { createdAt: "asc" },
        select: { id: true, topic: true, message: true, status: true, createdAt: true, attachments: { select: { providerId: true, mime: true, bytes: true } } },
      }),
    ]);
    zip["mentions.json"] = json(mentions.map((m) => ({ at: iso(m.createdAt), workspace: m.message.annotation.workspace.title, annotationId: m.message.annotation.id })));
    zip["notifications.json"] = json(notifications);
    zip["ownership-transfers.json"] = json(
      transfers.map((t) => ({ resource: t.workspace?.title ?? t.project?.name ?? null, from: t.fromUser.name, to: t.toUser.name, status: t.status, createdAt: iso(t.createdAt), respondedAt: iso(t.respondedAt) }))
    );
    zip["support/requests.json"] = json(tickets.map(({ attachments, ...t }) => ({ ...t, screenshots: attachments.length })));
    const shotNames = new Set<string>();
    for (const tk of tickets) {
      for (const a of tk.attachments) {
        await files.add(zip, {
          path: uniquePath(shotNames, `support/screenshots/${tk.id.slice(0, 8)}`, a.mime.split("/")[1] ?? "png"),
          providerId: a.providerId,
          resourceType: "image",
          bytes: a.bytes,
          label: `support — ${tk.id}`,
        });
      }
    }

    if (files.skipped.length > 0) {
      zip["files-not-included.txt"] = strToU8(
        [t("DataExport.skippedIntro", { mb: EXPORT_FILES_BUDGET_BYTES / (1024 * 1024) }), "", ...files.skipped].join("\n") + "\n"
      );
    }
    zip["README.txt"] = strToU8(t("DataExport.readme") + "\n");

    const data = zipSync(zip, { level: 6 });
    const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const upload = await getStorageProvider().uploadBuffer(buffer, {
      publicId: storagePath("exports", userId, exportId),
      resourceType: "raw",
      format: "zip",
      mime: "application/zip",
      isPublic: false,
      tags: ["export"],
    });
    const finishedAt = new Date();
    await db.dataExport.update({
      where: { id: exportId },
      data: {
        status: "READY",
        storageId: upload.publicId,
        bytes: upload.bytes,
        filesIncluded: files.included.length,
        filesSkipped: files.skipped.length,
        finishedAt,
        expiresAt: new Date(finishedAt.getTime() + EXPORT_DOWNLOAD_HOURS * 60 * 60 * 1000),
      },
    });
    await sendEmail("data-export-ready", row.user.email, { hours: EXPORT_DOWNLOAD_HOURS }, { locale }).catch(() => undefined);
  } catch (err) {
    log.error({ err: errInfo(err), exportId }, "[data-export] build failed");
    await db.dataExport.update({
      where: { id: exportId },
      data: { status: "FAILED", errorCode: "build_failed", finishedAt: new Date() },
    });
  }
}
