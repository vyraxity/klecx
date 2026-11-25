# Testing (Step 10.4)

Four layers, from fastest to slowest. None of them calls Gemini, Resend, Cloudinary or Creem.

| Layer | What | Where | Runs |
| --- | --- | --- | --- |
| Unit / service (Jest) | business rules, authorization (two-user suite), webhooks, credits, prompts, UI components | `__tests__/` | every push and PR (`ci.yml`), `npm test` |
| Coverage | at least **80 % of lines in `server/services`** (91.6 % on 2026-11-25) | `jest.config.ts` (`coverageThreshold`) | every push and PR (`npm run test:coverage`) |
| End-to-end (Playwright) | 13 journeys through the real UI: Chromium, WebKit, and a phone viewport for the `@mobile` ones | `e2e/*.e2e.ts` | nightly on `dev`, every PR into `main`, by hand (`e2e.yml`) |
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
- **Fake Creem** under the real Creem adapter: a checkout's URL is a local page that sends the same **signed** webhooks Creem would (checkout.completed, subscription.paid) to the real webhook route, so the real signature check and state machine run. `POST /api/test/subscribe` puts a person on a plan the same way; `POST /api/test/subscription-event` sends e.g. `subscription.past_due`.
- **Mock storage** (no Cloudinary keys) and **in-memory rate limits** (no Redis).
- `GET /api/test/ledger-check?email=` — balances equal their ledger sums and never went below zero.

**Safety:** `server/env.ts` refuses `E2E_TEST_MODE` whenever `VERCEL` is set (every Vercel deployment) and refuses the fake AI in production unless test mode is on. The `/api/test/*` routes answer 404 outside test mode (`__tests__/step-10-4-test-mode.test.ts` checks all of this).

## Running them

Jest: see `CLAUDE.md` (test database, environment). With coverage: `npm run test:coverage`.

End-to-end, locally:

1. Create the e2e database once (local Postgres): `createdb klecx_e2e`, or set `E2E_DATABASE_URL` to another empty database.
2. `npx playwright install chromium webkit` (once, on your machine).
3. `npm run e2e:build` — migrates the e2e database and builds the app in test mode (rebuild after changing app code).
4. `npm run e2e` — starts the build on port 3100 and runs every journey. One file: `npx playwright test e2e/07-billing.e2e.ts`; one browser: `--project=chromium`; watch it: `--headed`; step through: `--debug`.

In a Claude Code cloud session (Chromium only, preinstalled): `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test --trace off` (WebKit runs in CI).

Load test: `npm run e2e:build`, `npm run e2e:start` (keep it running), then `k6 run load/k6-load.js` ([install k6](https://grafana.com/docs/k6/latest/set-up/install-k6/)). Or Actions → **load** → Run workflow.

## The journeys

| File | Journey |
| --- | --- |
| `01-first-answer` | register → verify (test inbox) → claim username → first answer → regenerate → edit → switch versions |
| `02-annotations` | Comment with `@klecx` → Ask now → Asks at Level 2 and 3 → Back / Main → queue questions on two levels → Ask all → promote to the timeline and to a new workspace |
| `03-collaboration` | invite (Standard) → the member accepts and generates → the owner's credits drop, not the member's → `@mention` email → activity shows the member |
| `04-share-links` | share the workspace and one response → open signed out → revoke → 404 |
| `05-attachments` | attach a PDF and an image → the answer received both |
| `06-export` | export as PDF, Word and Markdown (file signatures checked) |
| `07-billing` | Free → Lite through Plan & billing and the simulated checkout → cancel → keep the plan → payment-issue banner |
| `08-sessions` | a second browser signs in → revoked from Sessions & devices → signed out |
| `09-languages` | app in French, answers in Spanish (Settings), a prompt asking for German wins for that answer |
| `10-documents` | add a DOCX → Ask Klecx to review → accept the fix → Save; generate a Word document → edit → download |
| `11-voice` | mocked microphone → Stop puts the transcript in the composer; Send while recording sends it |
| `12-ownership-transfer` | refused while it doesn't fit the recipient's plan → sent once it fits → accepted |
| `13-plan-gating` | Free: Standard model and inviting disabled with a reason; forged requests refused by the server |

Shared steps are in `e2e/helpers.ts` (`newUser` signs up through the API and verifies with the emailed link; every test uses fresh people, so tests never depend on each other).

## Flake policy

A flaky test is a bug. In CI a failed test is retried once; a pass on retry is reported as **flaky** in the run summary and the HTML report (uploaded on failure). Then:

- **within a day:** quarantine it — add `test.fixme()` with a comment linking the issue, so it stops blocking others;
- **within a week:** fix the cause (usually a missing wait for the saved state, or two tests sharing data) and remove the `fixme`.

Never "fix" a flaky test with a longer fixed `waitForTimeout`; wait for what the person would see instead.
