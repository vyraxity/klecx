# Accessibility (Step 10.5)

Klecx aims at **WCAG 2.2 level AA** in both themes. Three layers check it:

| Layer | What | Where | Runs |
| --- | --- | --- | --- |
| axe (automated) | WCAG 2.2 A/AA rules on every public page, the auth pages, `/workspaces`, a conversation with an answer and every Settings page, in the light **and** the dark theme | `e2e/14-accessibility.e2e.ts` (helper `e2e/a11y.ts`) | with the end-to-end journeys (nightly on `dev`, PRs into `main`, by hand) |
| Keyboard walkthrough | skip link → `[` sidebar shortcut → Ctrl+K palette → composer with Enter → Share dialog (focus back to its button on Escape) → selection toolbar with Ctrl+Alt+M | same file, `keyboard walkthrough` | same |
| Component tests | read-aloud player (Tab stops and names, "Part 1 of 2", polite announcements), Settings → Voice (disabled reason, slider value, sample names), focus returning from dialogs | `__tests__/step-10-5-read-aloud-a11y.test.tsx`, `__tests__/step-10-5-return-focus.test.tsx` | every push (Jest) |
| Lighthouse | accessibility ≥ 95 on marketing pages and the sign-in page | `lighthouserc.cjs` | with the end-to-end journeys |
| Screen reader (by hand) | the checklist below | — | before launch (Step 10.6) and after big UI changes |

axe can't judge everything (whether a label makes sense, reading order, what is announced when). The manual pass below covers that.

## Rules for new UI

- **Every control has a name** that contains its visible text (`label-content-name-mismatch`): don't put an `aria-label` that differs from the words on the button; icon-only buttons get `aria-label` (translated).
- **Text colours come from the tokens** (`text-fg`, `text-muted`, `text-subtle`, `text-success`, `text-danger`, `text-warning`, `text-info`). They are tuned to ≥ 4.5:1 on every surface (`bg`, `surface`, `surface-2`, `surface-3`) and on their own 15 % tint (`bg-success/15` …) in both themes (`app/globals.css`, 2026-11-26). Don't lighten them with opacity (`text-muted/70`) for normal-size text.
- **Dialogs, sheets and alerts give focus back** to what opened them, even when opened from state (no `…Trigger`): handled in `components/ui/dialog.tsx`, `alert-dialog.tsx` and `sheet.tsx` (`lib/a11y/return-focus.tsx`). Don't pass an `onCloseAutoFocus` that calls `preventDefault()` unless you move focus yourself.
- **Motion:** CSS animations and transitions stop under `prefers-reduced-motion` or Settings → Appearance → Reduce motion (`data-reduce-motion`). Scripted scrolling uses `scrollBehavior()` from `lib/a11y/motion.ts`, never `behavior: "smooth"` directly.
- **Touch targets:** ≥ 44 px on phones (`max-sm:h-11 max-sm:w-11` on small icon buttons; `Button` sizes already do it).
- **Live updates** use a polite `role="status"` region that announces a change once, not on every tick (see the read-aloud player).
- **Every page has a skip link** (first Tab stop, "Skip to main content") and one `<main id="main-content">`.

## Screen-reader checklist (NVDA + Firefox or Chrome on Windows)

Install NVDA (free, nvaccess.org). Useful keys: **NVDA = Insert** (or Caps Lock in laptop layout); `NVDA+Space` switches browse/focus mode; `H` / `Shift+H` next/previous heading; `D` landmarks; `B` buttons; `F` form fields; `Tab` interactive elements; `NVDA+F7` elements list; `Ctrl` stops speech. Use a test account with a few workspaces. Note anything that's silent, wrong, or announced twice.

**Signed out**

1. Home page: the first Tab says "Skip to main content, link"; Enter moves to the main content. Headings (`H`) give a sensible outline (one level 1).
2. Pricing: each plan's name, price, tax note and button are read in order; the comparison table is read as a table (`T`, then Ctrl+Alt+arrows) with row and column headers.
3. Sign in / Register: every field says its label; a wrong password is announced (error is read without moving the cursor away); the password requirements are read.

**Conversation page (`/workspaces/…`)**

4. Landmarks (`D`): navigation (sidebar), banner (top bar), main. The sidebar's workspace list is a list with the current workspace marked.
5. Composer: "How can Klecx help you today?, edit"; attach button and Send are named; after Send, the answer's arrival is announced (or reachable with `H` to its heading) and the stream doesn't read every token.
6. Response card toolbar: Copy, Regenerate, Versions, Read aloud, Export: each named, the versions control says which version is shown ("2 of 3").
7. Select text with Shift+arrows in browse mode → the selection toolbar appears; `Ctrl+Alt+M` opens the comment box ("Comment text, edit"), Escape closes it and returns to the text; `Ctrl+Alt+A` opens Ask.
8. Open a thread column: its heading is read; Back / Main are named; closing it returns focus to where you were.
9. Share dialog: opening it moves focus inside and reads its title; Tab stays inside; Escape closes and focus returns to **Share**.

**Read aloud**

10. Press **Read aloud**: "Reading aloud" is announced once; focus is on **Pause** inside "Read-aloud player, grouping". Tab reaches: Go to the text being read, Previous part (disabled on the first part), Pause, Next part, the counter is read as "Part 1 of 3", "Speed: 1×", Stop reading, Voice settings.
11. Pause → "Reading paused"; Resume → "Reading resumed"; Stop or Escape → "Reading stopped" and focus returns to **Read aloud**. Announcements don't repeat for every part.
12. On a plan without natural voices or after the daily limit, the switch to the device voice is announced (toast).

**Settings**

13. Settings → Voice: arrow keys move between "Device voice" and "Natural voices"; on Free, the natural option is read as dimmed/unavailable **with** the reason ("Natural voices come with Lite and up…"); each sample button says which voice it plays; the speed slider reads "1.25×", not "1.25".
14. Settings → Usage: the chart has a table view; the meters say used / limit.
15. Settings → Appearance: Reduce motion and Compact density switches say on/off.

**Both themes and zoom**

16. Repeat 5–10 quickly in the dark theme with Windows High Contrast on (focus outlines still visible).
17. Browser zoom 200 %: nothing is cut off; the composer and the read-aloud player stay usable; no horizontal scrolling on settings pages.

Record the date, NVDA and browser versions, and what failed, in the Step 10.6 launch checklist.

## Known limitations

- **No global shortcut to stop reading**: Escape works when focus is in the player; elsewhere use the text's own button (it shows "Reading…" and stops when pressed). A global shortcut wasn't added: single keys conflict with typing and screen-reader commands.
- VoiceOver (macOS/iOS) hasn't been through the checklist yet; NVDA is the reference.
