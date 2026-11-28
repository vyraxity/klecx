# Testing (Step 10.4)

Four layers, from fastest to slowest. None of them calls Gemini, Resend, Cloudinary or Creem.

| Layer | What | Where | Runs |
| --- | --- | --- | --- |
| Unit / service (Jest) | business rules, authorization (two-user suite), webhooks, credits, prompts, UI components | `__tests__/` | every push and PR (`ci.yml`), `npm test` |
| Coverage | at least **80 % of lines in `server/services`** (91.6 % on 2026-11-25) | `jest.config.ts` (`coverageThreshold`) | every push and PR (`npm run test:coverage`) |
| End-to-end (Playwright) | 19 journeys through the real UI: Chromium, WebKit, and a phone viewport for the `@mobile` ones | `e2e/*.e2e.ts` | nightly on `dev`, every PR into `main`, by hand (`e2e.yml`) |
| Lighthouse | marketing ≥ 90 performance / ≥ 95 accessibility / ≥ 95 SEO, sign-in ≥ 90 / ≥ 95, app ≥ 95 accessibility (Step 10.5, `docs/performance.md`) | `scripts/lighthouse.mjs` | with the journeys (`e2e.yml`, job `lighthouse`), `npm run lighthouse` |
| Load (k6) | 50 simultaneous answers, 20 sessions on one balance, ledger integrity, API p95 | `load/k6-load.js` | by hand (`load.yml`) |

## Test mode (`E2E_TEST_MODE=true`)

End-to-end and load tests run a **production build** of Klecx in test mode (`e2e/env.mjs` holds the whole environment; dummy values only):

- **Fake AI** (`AI_PROVIDER=fake`, `server/ai/providers/fake.ts`): deterministic, no network. It answers in the shape each feature parses (answers, Asks, the question queue, document reviews, titles, voice transcripts, the web-search step) and reports what it received: `I looked at 2 attached files.`, `(Answering in Spanish.)`. Directives in a prompt, for tests:
  - `[[fake:error:rate_limit]]` (or `unavailable`, `timeout`, `auth`, `safety`, `invalid_request`, `unknown`) → that provider error;
  - `[[fake:search]]` → one web search; `[[fake:docx]]` / `[[fake:pdf]]` / `[[fake:md]]` → a generated document;
  - `[[fake:slow]]` → slow streaming (to test Stop).
  - Document reviews flag the misspellings `teh`, `recieve` and `seperate`.
- **Fake voice** (natural read-aloud): a short tone per part.
- **Test inbox**: emails aren't sent; `GET /api/test/emails?to=` returns them with their links (sign-up verification, invitations, share links…).
- **Fake Creem** under the real Creem adapter: a checkout's URL is a local page that sends the same **signed** webhooks Creem would (checkout.completed, subscription.paid) to the real webhook route, so the real signature check and state machine run. `POST /api/test/subscribe` puts a person on a plan the same way; `POST /api/test/subscription-event` sends e.g. `subscription.past_due`. `POST /api/test/set-credits` (`{ email, balance }`) sets a plan balance through a ledger adjustment (`ADJUST`, so `ledger-check` stays consistent), for the low-credits journey. `POST /api/test/remove-password` (`{ email }`) removes the email-and-password sign-in method, so an account looks like one that signs in with Google/GitHub only.
- **Mock storage** (no Cloudinary keys) and **in-memory rate limits** (no Redis).
- `GET /api/test/ledger-check?email=` — balances equal their ledger sums and never went below zero.
- **Pseudo-locale** `en-XA` (Step 10.5, `lib/i18n/pseudo-locale.ts`): set the `NEXT_LOCALE` cookie to `en-XA` to see every text accented and ~30 % longer, e.g. "[Šåṽé ··]". Honoured in development and test mode only, never offered to people. Unaccented English on screen is a string that skips next-intl; text cut off or overflowing is a layout that only fits English.

**Safety:** `server/env.ts` refuses `E2E_TEST_MODE` whenever `VERCEL` is set (every Vercel deployment) and refuses the fake AI in production unless test mode is on. The `/api/test/*` routes answer 404 outside test mode (`__tests__/step-10-4-test-mode.test.ts` checks all of this).

## Running them

Jest: see `CLAUDE.md` (test database, environment). With coverage: `npm run test:coverage`.

End-to-end, locally (Windows, macOS or Linux):

1. Point the tests at an e2e database on your local Postgres: add `E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/klecx_e2e` (your user, password and port) to `.env` or `.env.local`. It's a **separate database inside the same Postgres server** (not a new container), and the build creates it if it doesn't exist. Never point it at your normal development database: the journeys fill it with test people.
2. `npx playwright install chromium webkit` (once).
3. `npm run e2e:build` — creates the database if needed, applies the migrations, then builds the app in test mode. It prints each step (`[e2e] …`) and ends with "Build ready". Rebuild after changing app code.
4. `npm run e2e` — starts the build on port 3100 and runs every journey. One file: `npx playwright test e2e/07-billing.e2e.ts`; one browser: `--project=chromium`; watch it: `--headed`; step through: `--debug`.

The test build and your normal `npm run build` share the `.next` folder: run `npm run e2e:build` again after a normal build before `npm run e2e`.

In a Claude Code cloud session (Chromium only, preinstalled): `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test --trace off` (WebKit runs in CI).

Load test: `npm run e2e:build`, `npm run e2e:start` (keep it running), then `k6 run load/k6-load.js` ([install k6](https://grafana.com/docs/k6/latest/set-up/install-k6/)). Or Actions → **load** → Run workflow.

## The journeys

| File | Journey |
| --- | --- |
| `01-first-answer` | register → verify (test inbox) → claim username → first answer → regenerate → edit → switch versions |
| `02-annotations` | Comment with `@klecx` → Ask now → Asks at Level 2 and 3 → Back / Main → queue questions on two levels → Ask all → promote to the timeline and to a new workspace |
| `03-collaboration` | invite (Standard) → the member accepts and generates → the owner's credits drop, not the member's → `@mention` email → activity shows the member; the owner's `@all` (first in the mention list, "Notifies 1 person") emails the member that everyone was mentioned |
| `04-share-links` | share the workspace and one response → open signed out → revoke → 404 |
| `05-attachments` | attach a PDF and an image → the answer received both |
| `06-export` | export as PDF, Word and Markdown (file signatures checked) |
| `07-billing` | Free → Lite through Plan & billing and the simulated checkout → cancel → keep the plan → payment-issue banner |
| `08-sessions` | a second browser signs in → revoked from Sessions & devices → signed out |
| `09-languages` | app in French, answers in Spanish (Settings), a prompt asking for German wins for that answer |
| `10-documents` | add a DOCX → Ask Klecx to review → accept the fix → Save; generate a Word document → edit → download |
| `11-voice` | mocked microphone → Stop puts the transcript in the composer; Send while recording sends it (skipped, with that reason, in a browser without `MediaRecorder`, where the app doesn't offer voice input) |
| `12-ownership-transfer` | refused while it doesn't fit the recipient's plan → sent once it fits → accepted |
| `13-plan-gating` | Free: Standard model and inviting disabled with a reason; forged requests refused by the server |
| `14-accessibility` | axe (WCAG 2.2 AA) on every public page, the auth pages, the workspace list, a conversation and every Settings page, light and dark theme; keyboard walkthrough (skip link, `[`, Ctrl+K, composer, Share dialog focus return, Ctrl+Alt+M) — `docs/accessibility.md` |
| `15-pseudo-locale` | pseudo-locale `en-XA` (texts ~30 % longer and accented) on public and app pages, desktop and phone: no sideways scroll, no cut-off button or link text |
| `16-landing-and-help` | a signed-in visitor sees "Go to your workspaces" on the landing page (signed-out visitors see Sign in / Get started); `/help?q=` opens filtered and typing keeps the URL in step; the not-found page's search lands on filtered help |
| `17-topbar-and-annotations-panel` | the Comments & Asks button counts comments and answered Asks (not queued questions), the panel has two tabs and long text wraps; on Settings (reached in the app) the top bar shows "Settings" and "Back to <workspace>" and none of the workspace's actions, and the link returns to that workspace; Settings opened directly links back to the workspaces |
| `18-default-model-and-low-credits` | Free starts on Fast & Efficient, a paid plan on Standard Reasoning; with too few credits for the chosen model the composer warns with the numbers, blocks Send and offers Fast & Efficient; a long message the balance can't cover is refused with "needs about N, you have M"; Settings → Language & AI changes the default (balances set with the test-only `POST /api/test/set-credits`, a ledger adjustment) |
| `19-set-password` | an account without a password (test-only `POST /api/test/remove-password`) adds one in Settings → Security: new password twice → emailed 6-digit code (a wrong one is refused) → the card switches to "Change password", the alert email arrives and the new password signs in; a password-reset link opens while signed in |

Shared steps are in `e2e/helpers.ts` (`newUser` signs up through the API and verifies with the emailed link; every test uses fresh people, so tests never depend on each other).

## Flake policy

A flaky test is a bug. In CI a failed test is retried once; a pass on retry is reported as **flaky** in the run summary and the HTML report (uploaded on failure). Then:

- **within a day:** quarantine it — add `test.fixme()` with a comment linking the issue, so it stops blocking others;
- **within a week:** fix the cause (usually a missing wait for the saved state, or two tests sharing data) and remove the `fixme`.

Never "fix" a flaky test with a longer fixed `waitForTimeout`; wait for what the person would see instead.
