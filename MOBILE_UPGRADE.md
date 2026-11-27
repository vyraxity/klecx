# Mobile upgrade plan (after launch)

**Goal:** make Klecx feel like a mobile app on phones, installed or not, until the React Native app exists. Planned for **right after launch**, possibly while Creem reviews the store. Owner's request, 2026-11-27.

This file collects everything that work needs: the measured problems, the fixes, and the mobile/PWA features. Add to it whenever a review or a test finds something mobile-specific; turn items into steps (one PR each) when the work starts.

---

## 1. Where we are (2026-11-27)

### Measured: Lighthouse on `dev.klecx.com`, Chrome DevTools, device **Mobile**

| Page | Performance | FCP | LCP | TBT | CLS | Speed Index |
| --- | --- | --- | --- | --- | --- | --- |
| `/help` | **74** | 1.6 s | 2.0 s | **1,230 ms** | 0.001 | 2.8 s |
| `/auth/login` | **78** | 1.5 s | 1.8 s | **900 ms** | 0 | 2.6 s |
| `/workspaces` | **64** | 1.6 s | 2.0 s | **1,950 ms** | 0 | **7.3 s** |
| `/settings/usage` | **57** | 1.5 s | 1.9 s | **1,630 ms** | **0.206** | **6.1 s** |

Every page scored low on Mobile (the owner tested all of them; the table has the ones with screenshots). On **Desktop** all pages meet the targets, and **Accessibility** is green everywhere, on both.

What the numbers mean:

- **Lighthouse "Mobile" simulates a mid-range phone**: about a **4× slower processor** and a slow 4G connection. Desktop uses neither, which is why the same pages pass there.
- **FCP / LCP are fine everywhere** (first text and the main content appear in about 1.5–2 s). The pages *arrive* quickly.
- **Total Blocking Time (TBT) is the main problem on every page**: 0.9–2 s during which a phone's processor is busy running JavaScript and the page can't respond to a tap. It is most of the score loss.
- **Speed Index 6–7 s on app pages**: the page is visible early but keeps changing for seconds, because its content is fetched *after* the JavaScript has started (skeletons first, data later).
- **CLS 0.206 on `/settings/usage`**: things move after they appear — the charts and meters take their real size when the data arrives.

Targets for this work: **Mobile Performance ≥ 80 on marketing and sign-in, ≥ 70 on app pages** to start with (Lighthouse's own scale treats 90+ as good; a heavy app on a simulated mid-range phone rarely gets there, and real-user numbers matter more — §4), CLS < 0.1 everywhere, TBT < 600 ms.

### What already exists

- **Web app manifest** (`app/manifest.ts`, translated): name, icons (192, 512, Apple 180 from `app/icon.tsx` / `app/apple-icon.tsx`), `display: standalone`, theme and background colours. That's why Chrome on Android already offers "Install app".
- **No service worker**: nothing works offline; the `/offline` page and the offline banner (`components/offline/offline-banner.tsx`) only help while a page is already open.
- **Phone layout**: the sidebar becomes a drawer below `md`, density "compact" is desktop-only so phones keep full-size tap targets (Step 9.2), 44 px targets in the read-aloud player (Step 10.5), touch selection for annotations (`__tests__/fix-touch-annotations.test.tsx`), safe-area padding at the bottom of the app shell.
- **No `viewport` / `theme-color` settings** of our own (Next.js defaults).
- End-to-end journeys already run on a phone viewport (`mobile` project, `@mobile` tag).

---

## 2. Performance fixes (mobile)

In order of expected effect. Measure before and after each with `npm run analyze` (bundle) and Lighthouse **Mobile** (§4).

1. **Ship less JavaScript with the app shell.** Today every signed-in page loads the whole shell at once: sidebar, command palette, Share dialog (`ShareAndPeopleDialog`, ~2,000 lines), upgrade dialog, notes popover, notifications, read-aloud player, claim-username dialog, all annotation code… Load what isn't on screen when it's first needed (`next/dynamic`): dialogs, popovers, the command palette, the read-aloud player, the all-annotations drawer, the onboarding checklist. Expected: the biggest drop in TBT on `/workspaces` and Settings.
2. **Render more on the server.** Pages whose content doesn't change while you look at them (help center list, legal pages, the static parts of Settings) can be server components, sending HTML instead of JavaScript. `components/help/help-center-view.tsx` is a client component for its search box: keep only the search/filter as a small client island and render the list on the server. Same idea for the marketing header/footer and the auth pages' wrapper.
3. **Send the first data with the page** (Speed Index). App pages fetch their data after the JavaScript runs (TanStack Query). Pre-fetch the first screen's data on the server and hand it to the client (`HydrationBoundary` / initial data): workspace list, credits, the Settings page's own data. The page then shows real content at once instead of skeletons.
4. **No layout shifts** (CLS): skeletons must have the final size of what they stand for — `/settings/usage` charts and meters first; check the credits card, the onboarding checklist and the banners (claim username, payment issue, locale suggestion) that appear above content.
5. **Smaller dependencies on the critical path.** Check with the analyzer: `lucide-react` imports (only named icons, `optimizePackageImports`), zod in the browser (only the schemas forms need), date/number formatting, Sentry's browser SDK once enabled (load it after the page is interactive, sample less on mobile).
6. **Fonts:** check how many weights/subsets load (`next/font`), preload only the ones above the fold.
7. **Hydration work:** components that render twice for browser-only values (theme, time-of-day greeting, voice support) — keep them small.
8. **Third parties:** none load on marketing pages today; keep it that way (any analytics or chat widget would undo the work).

---

## 3. Mobile and PWA features

### 3.1 Install and app feel

- **Service worker** (with a maintained library such as Serwist, or hand-written; decide in the step): cache the app shell, fonts, icons and static files; serve `/offline` when there's no network; **update flow** ("A new version of Klecx is available — Reload").
  - **Privacy:** never cache API answers, workspace content, files or anything signed-in (`/api/*`, `/s/*`, documents, exports). Sign-out clears the caches. CSP: `worker-src 'self'` is already allowed (`lib/security/csp.ts`); check `connect-src` for the worker.
- **Manifest:** `id`, `scope`, `start_url` = `/workspaces` (signed-in people land in the app; signed-out ones are redirected to sign in), **maskable icons** (Android crops icons into circles/squircles), **shortcuts** (New workspace, Settings), **screenshots** (Android shows a richer install sheet), `display_override`, `categories`.
- **Own install prompt:** catch `beforeinstallprompt` (Android/desktop Chrome) and offer "Install Klecx" at a good moment (after the first answer, never on the first visit), remembered when dismissed; **iOS** has no prompt: a short "Add to Home Screen" hint (Share → Add to Home Screen) shown once on iPhone Safari. Text in `en`, `es`, `fr`.
- **Viewport and colours:** `viewport-fit=cover` with safe-area insets on all edges (notch, home bar), `theme-color` for light and dark (`media="(prefers-color-scheme: …)"`), `interactive-widget=resizes-content` so the on-screen keyboard resizes the page instead of covering the composer, Apple status-bar style.
- **No zoom on focus (iOS):** inputs at least 16 px font on phones (iOS zooms into smaller ones).
- **Standalone mode details:** external links open in the browser; check **sign-in with Google/GitHub** and the **Creem checkout and portal** from the installed app (iOS opens them in Safari and may not come back to the app — test, and use a "Return to Klecx" page if needed); copy/share links use the **Web Share API** (`navigator.share`) when available.

### 3.2 Phone layout and gestures

- **Composer above the keyboard** (`visualViewport`), Send always reachable, attachments sheet instead of a menu on phones.
- **Navigation:** decide between the current drawer and a bottom bar (Workspaces · New · Notifications · Settings); back gesture/button closes sheets, threads and dialogs before leaving the page (history entries for open columns).
- **Threads and columns on phones:** each Ask/thread column opens as a full-screen sheet with a clear back button (today's column stack is built for wide screens).
- **Selection toolbar on touch:** position above the system selection menu, larger buttons; re-test highlights, Comment/Ask and quick fixes with fingers.
- **Read-aloud player** at the bottom on phones (thumb reach), above the safe area; lock-screen controls through the **Media Session API**.
- **Pull-to-refresh / overscroll:** `overscroll-behavior` so scrolling a column doesn't reload the page.
- **Tables and wide content** (Markdown tables, code, usage tables): horizontal scroll inside the block, never the page (the pseudo-locale journey already checks no page-level sideways scroll).
- **Long-press / context menus** where desktop uses hover (hovercards, tooltips, quick-fix previews).

### 3.3 Later (owner to decide; add to `OPEN_DECISIONS.md` when it comes up)

- **Push notifications** (mentions, invitations, ready exports): needs the service worker, permission, a push service and a new setting; iOS only for installed apps (16.4+).
- **Share target:** "Share to Klecx" from other apps (text, links, files) to start a workspace (`share_target` in the manifest).
- **Offline reading** of recent workspaces (cached on the device, encrypted? cleared on sign-out) — privacy review first.

---

## 4. Testing

- **Lighthouse Mobile in CI:** add a mobile run (Lighthouse's default mobile settings) to `scripts/lighthouse.mjs` next to the desktop one, first as a report only, then with the targets above.
- **Real devices:** an Android phone (Chrome) and an iPhone (Safari), installed and not installed: sign up, first answer, annotations by touch, read-aloud, upload from the camera roll, Plan & billing → checkout → back.
- **Real-user numbers:** lab scores vary with the machine (see `docs/performance.md`); real visitors' numbers (Vercel Speed Insights or Sentry's web vitals, Privacy Policy updated if added) show what phones actually get.
- **DevTools → Application → Manifest / Service workers:** installability, icons, offline behaviour.
- The end-to-end `mobile` project gets journeys for the new phone behaviour (keyboard + composer, sheets, back button).
