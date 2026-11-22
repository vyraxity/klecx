import "server-only";
import { db } from "@/server/db/client";
import type { Actor } from "@/server/auth/session";
import { getAccountByUserId } from "@/server/services/credits";
import { ensureCurrentGrantForUser } from "@/server/billing/grants";
import { getEntitlements } from "@/server/billing/entitlements";
import type { PlanKey } from "@/server/billing/plans";

export interface HomeRecentWorkspace {
  id: string;
  title: string;
  projectId: string | null;
  projectName: string | null;
  lastActivityAt: string;
  updatedAt: string;
  lastSnippet: string | null;
}

export interface HomeProjectCard {
  id: string;
  name: string;
  description: string | null;
  workspacesCount: number;
  membersCount: number;
  updatedAt: string;
}

export interface HomeSharedWorkspace {
  id: string;
  title: string;
  ownerName: string;
  lastActivityAt: string;
  updatedAt: string;
}

export interface HomeCredits {
  /** Effective plan from the entitlements (Step 8.1); the UI translates `Plans.<plan>.name`. */
  plan: PlanKey;
  balance: number;
  resetsAt: string | null;
}

export interface HomeOnboarding {
  emailVerified: boolean;
  usernameChosen: boolean;
  hasWorkspace: boolean;
  hasProject: boolean;
  /** Step 9.2: hidden by the person (saved on the account). */
  dismissed: boolean;
}

export interface HomeData {
  recent: HomeRecentWorkspace[];
  projects: HomeProjectCard[];
  sharedWithMe: HomeSharedWorkspace[];
  credits: HomeCredits;
  onboarding: HomeOnboarding;
}

function truncateSnippet(text: string, maxLength = 160): string {
  const cleaned = text.replace(/[\r\n]+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength).trim() + "…";
}

function toHomeCredits(
  account: { planBalance: number; topupBalance: number } | null,
  plan: PlanKey,
  resetsAt: Date | null
): HomeCredits {
  return {
    plan,
    balance: (account?.planBalance ?? 0) + (account?.topupBalance ?? 0),
    resetsAt: resetsAt?.toISOString() ?? null,
  };
}

/**
 * Step 8.4: grants the allowance of the current period first, so the balance
 * shown is the one the person can spend, and returns when it next resets.
 */
async function currentGrant(userId: string): Promise<Date | null> {
  try {
    return (await ensureCurrentGrantForUser(userId)).resetsAt;
  } catch (e) {
    console.error({ home: "ensure_current_grant", err: e instanceof Error ? e.message : "unknown" });
    return null;
  }
}

/** Credits summary only (Settings), without the rest of the home dashboard. */
export async function getHomeCredits(userId: string): Promise<HomeCredits> {
  const resetsAt = await currentGrant(userId);
  const [account, entitlements] = await Promise.all([
    getAccountByUserId(userId).catch(() => null),
    getEntitlements(userId),
  ]);
  return toHomeCredits(account, entitlements.plan, resetsAt);
}

export async function getHomeData(actor: Actor): Promise<HomeData> {
  const resetsAt = await currentGrant(actor.userId);

  // Run independent database fetches in parallel
  const [userRecord, creditAccount, entitlements, recentRows, projectRows, sharedRows, workspaceCount, projectCount] =
    await Promise.all([
      db.user.findUnique({
        where: { id: actor.userId },
        select: {
          name: true,
          email: true,
          emailVerified: true,
          preference: { select: { onboardingDismissed: true } },
        },
      }),
      getAccountByUserId(actor.userId).catch(() => null),
      getEntitlements(actor.userId),
      db.workspace.findMany({
        where: {
          deletedAt: null,
          archivedAt: null,
          OR: [
            { ownerId: actor.userId },
            {
              members: {
                some: {
                  userId: actor.userId,
                },
              },
            },
            {
              project: {
                deletedAt: null,
                OR: [
                  { ownerId: actor.userId },
                  { members: { some: { userId: actor.userId } } },
                ],
              },
            },
          ],
        },
        orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
        take: 6,
        select: {
          id: true,
          title: true,
          projectId: true,
          lastActivityAt: true,
          updatedAt: true,
          project: {
            select: {
              name: true,
            },
          },
          responses: {
            where: { deletedAt: null },
            orderBy: [{ sortAt: "desc" }, { id: "desc" }],
            take: 1,
            select: {
              prompt: true,
              versions: {
                where: { status: "COMPLETE" },
                orderBy: { number: "desc" },
                take: 1,
                select: { content: true },
              },
            },
          },
        },
      }),
      db.project.findMany({
        where: {
          deletedAt: null,
          archivedAt: null,
          OR: [
            { ownerId: actor.userId },
            { members: { some: { userId: actor.userId } } },
          ],
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 8,
        select: {
          id: true,
          name: true,
          description: true,
          updatedAt: true,
          _count: {
            select: {
              workspaces: { where: { deletedAt: null } },
              members: true,
            },
          },
        },
      }),
      db.workspace.findMany({
        where: {
          deletedAt: null,
          archivedAt: null,
          ownerId: { not: actor.userId },
          OR: [
            {
              members: {
                some: {
                  userId: actor.userId,
                },
              },
            },
            {
              project: {
                deletedAt: null,
                OR: [
                  { ownerId: actor.userId },
                  { members: { some: { userId: actor.userId } } },
                ],
              },
            },
          ],
        },
        orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
        take: 6,
        select: {
          id: true,
          title: true,
          lastActivityAt: true,
          updatedAt: true,
          owner: {
            select: {
              name: true,
              email: true,
            },
          },
        },
      }),
      db.workspace.count({
        where: { ownerId: actor.userId, deletedAt: null },
      }),
      db.project.count({
        where: { ownerId: actor.userId, deletedAt: null },
      }),
    ]);

  const recent: HomeRecentWorkspace[] = recentRows.map((ws) => {
    let lastSnippet: string | null = null;
    const latestResp = ws.responses[0];
    if (latestResp) {
      const versionContent = latestResp.versions[0]?.content;
      if (versionContent && versionContent.trim()) {
        lastSnippet = truncateSnippet(versionContent);
      } else if (latestResp.prompt && latestResp.prompt.trim()) {
        lastSnippet = truncateSnippet(latestResp.prompt);
      }
    }

    return {
      id: ws.id,
      title: ws.title,
      projectId: ws.projectId,
      projectName: ws.project?.name ?? null,
      lastActivityAt: (ws.lastActivityAt || ws.updatedAt).toISOString(),
      updatedAt: ws.updatedAt.toISOString(),
      lastSnippet,
    };
  });

  const projects: HomeProjectCard[] = projectRows.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    workspacesCount: p._count.workspaces,
    membersCount: p._count.members,
    updatedAt: p.updatedAt.toISOString(),
  }));

  const sharedWithMe: HomeSharedWorkspace[] = sharedRows.map((ws) => ({
    id: ws.id,
    title: ws.title,
    ownerName: ws.owner.name || ws.owner.email,
    lastActivityAt: (ws.lastActivityAt || ws.updatedAt).toISOString(),
    updatedAt: ws.updatedAt.toISOString(),
  }));

  const email = userRecord?.email ?? actor.email;
  const name = userRecord?.name ?? actor.name ?? "";
  const emailPrefix = email.split("@")[0] || "";
  const usernameChosen = Boolean(
    name.trim().length > 0 && name.trim().toLowerCase() !== emailPrefix.toLowerCase()
  );

  return {
    recent,
    projects,
    sharedWithMe,
    credits: toHomeCredits(creditAccount, entitlements.plan, resetsAt),
    onboarding: {
      emailVerified: Boolean(userRecord?.emailVerified),
      usernameChosen,
      hasWorkspace: workspaceCount > 0,
      hasProject: projectCount > 0,
      dismissed: userRecord?.preference?.onboardingDismissed ?? false,
    },
  };
}
