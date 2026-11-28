/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";
import { db } from "@/server/db/client";
import {
  getDisplayPreferences,
  getUserPreferences,
  updateUserPreferences,
} from "@/server/services/user-preferences";
import { GET as getPrefs, PATCH as patchPrefs } from "@/app/api/v1/me/preferences/route";
import { suggestLocale, COUNTRY_LOCALE } from "@/lib/i18n/locale-suggestion";
import { parseTheme, serverThemeAttribute } from "@/lib/theme";
import { STORAGE_ITEMS } from "@/lib/legal/cookies";
import type { Actor } from "@/server/auth/session";

let mockActor: Actor | null = null;
jest.mock("../server/auth/session", () => {
  const actual = jest.requireActual("../server/auth/session");
  return { ...actual, getActor: jest.fn(async () => mockActor) };
});

const suffix = `${Date.now()}`.slice(-7);
const A = { id: `s92_a_${suffix}`, email: `s92_a_${suffix}@example.com` };
const B = { id: `s92_b_${suffix}`, email: `s92_b_${suffix}@example.com` };

function req(method: string, body?: unknown) {
  return new NextRequest("http://localhost:3000/api/v1/me/preferences", {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeAll(async () => {
  await db.userPreference.deleteMany({ where: { userId: { in: [A.id, B.id] } } });
  await db.user.deleteMany({ where: { id: { in: [A.id, B.id] } } });
  for (const u of [A, B]) await db.user.create({ data: { id: u.id, email: u.email, name: u.id } });
});

afterAll(async () => {
  await db.userPreference.deleteMany({ where: { userId: { in: [A.id, B.id] } } });
  await db.user.deleteMany({ where: { id: { in: [A.id, B.id] } } });
});

beforeEach(() => {
  mockActor = null;
});

describe("Step 9.2 — preferences model", () => {
  it("returns the full object with defaults and writes no row until the first change", async () => {
    const prefs = await getUserPreferences(B.id);
    expect(prefs).toMatchObject({
      uiLocale: null,
      aiLanguage: null,
      webSearchEnabled: true,
      theme: "system",
      themeSaved: false,
      enterToSend: true,
      reduceMotion: null,
      voiceProvider: null,
      voiceId: null,
      voiceSpeed: 1,
      onboardingDismissed: false,
      density: "comfortable",
    });
    expect(await db.userPreference.count({ where: { userId: B.id } })).toBe(0);
    expect(await getDisplayPreferences(B.id)).toEqual({ theme: null, reduceMotion: false, density: "comfortable" });
  });

  it("saves theme, enter-to-send, reduced motion and the onboarding dismissal", async () => {
    const out = await updateUserPreferences(A.id, {
      theme: "dark",
      enterToSend: false,
      reduceMotion: true,
      onboardingDismissed: true,
      density: "compact",
    });
    expect(out).toMatchObject({ theme: "dark", themeSaved: true, enterToSend: false, reduceMotion: true, onboardingDismissed: true, density: "compact" });
    // Other fields keep their defaults.
    expect(out.webSearchEnabled).toBe(true);
    expect(await getDisplayPreferences(A.id)).toEqual({ theme: "dark", reduceMotion: true, density: "compact" });

    const back = await updateUserPreferences(A.id, { reduceMotion: null, theme: "system" });
    expect(back).toMatchObject({ reduceMotion: null, theme: "system", themeSaved: true, enterToSend: false });
  });
});

describe("Step 9.2 — /api/v1/me/preferences", () => {
  it("401 without a session (GET and PATCH)", async () => {
    expect((await getPrefs(req("GET"))).status).toBe(401);
    expect((await patchPrefs(req("PATCH", { theme: "dark" }))).status).toBe(401);
  });

  it("only touches the caller's own row", async () => {
    mockActor = { userId: B.id, email: B.email, role: "USER", sessionId: "s" } as Actor;
    const res = await patchPrefs(req("PATCH", { theme: "light" }));
    expect(res.status).toBe(200);
    expect((await getDisplayPreferences(B.id)).theme).toBe("light");
    expect((await getDisplayPreferences(A.id)).theme).toBe("system");
  });

  it("sets the device's theme cookie when the theme changes", async () => {
    mockActor = { userId: B.id, email: B.email, role: "USER", sessionId: "s" } as Actor;
    const res = await patchPrefs(req("PATCH", { theme: "dark" }));
    expect(res.headers.get("set-cookie")).toMatch(/(^|, )theme=dark/);
    const other = await patchPrefs(req("PATCH", { enterToSend: true }));
    expect(other.headers.get("set-cookie") ?? "").not.toMatch(/theme=/);
  });

  it("rejects unknown themes and voice fields (read-only until Step 9.4)", async () => {
    mockActor = { userId: B.id, email: B.email, role: "USER", sessionId: "s" } as Actor;
    expect((await patchPrefs(req("PATCH", { theme: "sepia" }))).status).toBe(422);
    expect((await patchPrefs(req("PATCH", { voiceProvider: "x" }))).status).toBe(422);
    expect((await patchPrefs(req("PATCH", { reduceMotion: false }))).status).toBe(422);
    expect((await patchPrefs(req("PATCH", { density: "tiny" }))).status).toBe(422);
  });

  it("GET returns the full object", async () => {
    mockActor = { userId: B.id, email: B.email, role: "USER", sessionId: "s" } as Actor;
    const { data } = await (await getPrefs(req("GET"))).json();
    expect(Object.keys(data).sort()).toEqual(
      [
        "aiLanguage", "defaultModelKey", "density", "enterToSend", "onboardingDismissed", "reduceMotion", "theme", "themeSaved",
        "uiLocale", "updatedAt", "voiceId", "voiceProvider", "voiceSpeed", "webSearchEnabled",
      ].sort()
    );
  });
});

describe("Step 9.2 — theme helpers", () => {
  it("parses only known themes and leaves 'system' to the head script", () => {
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("sepia")).toBeNull();
    expect(parseTheme(undefined)).toBeNull();
    expect(serverThemeAttribute("system")).toBeUndefined();
    expect(serverThemeAttribute("light")).toBe("light");
  });

  it("lists the theme and the suggestion as cookies in the cookie policy", () => {
    const byName = (n: string) => STORAGE_ITEMS.find((i) => i.names.includes(n));
    expect(byName("theme")?.kind).toBe("cookie");
    expect(byName("klecx_locale_suggestion")?.kind).toBe("cookie");
  });
});

describe("Step 9.2 — language suggestion", () => {
  const base = { currentLocale: "en", country: "FR", hasChosenLocale: false, dismissed: false };

  it("suggests the country's language when it differs from the page", () => {
    expect(suggestLocale(base)).toBe("fr");
    expect(suggestLocale({ ...base, country: "mx" })).toBe("es");
  });

  it("stays quiet when chosen, dismissed, already matching, unknown or ambiguous", () => {
    expect(suggestLocale({ ...base, hasChosenLocale: true })).toBeNull();
    expect(suggestLocale({ ...base, dismissed: true })).toBeNull();
    expect(suggestLocale({ ...base, currentLocale: "fr" })).toBeNull();
    expect(suggestLocale({ ...base, country: null })).toBeNull();
    expect(suggestLocale({ ...base, country: "NG" })).toBeNull();
    expect(COUNTRY_LOCALE.CA).toBeUndefined();
    expect(COUNTRY_LOCALE.BE).toBeUndefined();
  });
});
