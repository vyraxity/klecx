
/** Pre-10.6 fix: names kept for group mentions (`@all` now, the rest later). */
export const RESERVED_FOR_GROUP_MENTIONS = [
  "all",
  "everyone",
  "here",
  "owner",
  "owners",
  "admins",
  "editor",
  "editors",
  "commenter",
  "commenters",
  "viewer",
  "viewers",
  "member",
  "members",
  "team",
  "group",
  "guest",
  "guests",
  "ai",
  "assistant",
  "moderator",
] as const;

export const RESERVED_USERNAMES = new Set<string>([
  "admin",
  "root",
  "support",
  "help",
  "api",
  "klecx",
  "billing",
  "security",
  "staff",
  "system",
  "null",
  "undefined",
  "www",
  "mail",
  "app",
  "settings",
  "login",
  "register",
  "share",
  "s",
  "me",
  "user",
  "users",
  "account",
  "profile",
  "auth",
  "dashboard",
  "workspace",
  "workspaces",
  "project",
  "projects",
  "terms",
  "privacy",
  "status",
  "docs",
  "pricing",
  "bot",
  "quickbot",
  "superuser",
  // Pre-10.6 fix (owner, 2026-11-27): group mentions. `@all` notifies everyone
  // in a workspace; the others are kept free for future group mentions
  // (roles, the owner, the team). `scripts/list-reserved-username-conflicts.mjs`
  // lists accounts that took one of these before they were reserved.
  ...RESERVED_FOR_GROUP_MENTIONS,
]);

// Basic profane / blocked substrings or terms
const BLOCKED_TERMS = new Set([
  "fuck",
  "shit",
  "bitch",
  "asshole",
  "cunt",
  "dick",
  "pussy",
  "nigger",
  "faggot",
  "whore",
  "slut",
  "bastard",
]);

export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

export function generateDefaultUsername(): string {
  // `user_` + 8 random base-36 chars
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  // Web Crypto (browser and server): importing node:crypto here pulled a
  // ~430 KB polyfill into every app page (Step 10.1).
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
  let suffix = "";
  for (let i = 0; i < 8; i++) {
    const byte = bytes[i] ?? 0;
    suffix += chars[byte % chars.length] ?? "0";
  }
  return `user_${suffix}`;
}

export type UsernameValidationResult =
  | { valid: true; normalized: string }
  | { valid: false; reason: string };

export function validateUsernameFormat(raw: string): UsernameValidationResult {
  const normalized = normalizeUsername(raw);

  if (normalized.length < 3) {
    return { valid: false, reason: "Username must be at least 3 characters long." };
  }
  if (normalized.length > 30) {
    return { valid: false, reason: "Username cannot exceed 30 characters." };
  }
  if (!/^[a-z]/.test(normalized)) {
    return { valid: false, reason: "Username must start with a letter." };
  }
  if (normalized.includes("__")) {
    return { valid: false, reason: "Username cannot contain consecutive underscores." };
  }
  if (!/^[a-z][a-z0-9_]{2,29}$/.test(normalized)) {
    return { valid: false, reason: "Username can only contain lowercase letters, numbers, and underscores." };
  }
  if (RESERVED_USERNAMES.has(normalized)) {
    return { valid: false, reason: "This username is reserved." };
  }
  for (const term of BLOCKED_TERMS) {
    if (normalized.includes(term)) {
      return { valid: false, reason: "This username is not permitted." };
    }
  }

  return { valid: true, normalized };
}
