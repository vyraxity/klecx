# Feature switches and the AI kill switch (Step 10.6)

Some features can be **paused without a code change**, for example when the AI provider has an outage, costs spike, a feature is being abused, or a tester finds a serious bug. Pausing never deletes anything, and turning the feature back on restores it as it was.

The code is in `server/flags.ts` (server) and `lib/features/flags.ts` (the list of keys, shared with the browser).

## The switches

| Key | What it pauses | What keeps working | What people see |
| --- | --- | --- | --- |
| `ai` | **The kill switch.** Every new AI call: answers, regenerations, Asks, the question queue, reviews, voice input, natural-voice read-aloud (not yet cached) and voice previews. | Everything else: reading, comments, `@mentions`, downloads, sharing, settings. Answers already being written finish. Cached read-aloud audio still plays. | A banner at the top of the app ("AI is paused for a moment"); Send, the microphone and "Ask Klecx to review" are greyed out with "Paused for a moment"; a request that gets through anyway answers 503 `ai_paused`. |
| `webSearch` | The web-search tool. | Answers (written without searching; no search surcharge). | Nothing special: the answer just doesn't cite web sources. |
| `voiceInput` | Voice input (transcription). | Typing. | The microphone is greyed out; 503 `feature_paused`. |
| `naturalVoices` | Natural voices for read-aloud (new audio). | Read-aloud with the browser's voice; audio already generated plays as before. | The player switches to the browser voice ("unavailable"). |
| `documentReview` | "Ask Klecx to review". | Existing review comments and their fixes. | The Review button is greyed out; 503 `feature_paused`. |
| `collaboration` | New invitations, resending invitations, new share links. | Existing members, existing invitations (they can still be accepted) and existing share links. | "This feature is paused for a moment…" in the invite / share dialog. |
| `signups` | New accounts (email and Google/GitHub). | Signing in to existing accounts. | "New sign-ups are paused for now…" on the sign-up form. A Google/GitHub sign-up lands on the sign-in error page. |
| `checkout` | New purchases and plan upgrades. | Webhooks, credits for renewals, cancel, resume, the payment portal and invoices. | "This feature is paused for a moment…" on Plan & billing. |

A feature is **on** unless either of the two layers below turns it off. Neither layer can turn on something the code keeps off: image generation has its own build-time switch (`NEXT_PUBLIC_IMAGE_GENERATION_ENABLED`, `CLAUDE.md` "Text-only launch"), and billing stays hidden until `BILLING_ENABLED=true`. For the whole site, `MAINTENANCE_MODE=true` sends every page to `/maintenance`.

## Layer 1: `DISABLED_FEATURES` (environment variable)

For a feature that should stay off on a deployment, e.g. `DISABLED_FEATURES="voiceInput,documentReview"`.

- Vercel: Project → Settings → Environment Variables → add or edit `DISABLED_FEATURES` for **Production** or **Preview** → Save → **Redeploy** the latest deployment (Vercel applies variables only to new deployments; this takes a minute or two).
- An unknown key (a typo) stops the app from starting, with the list of known keys in the build/function log. That's on purpose: a typo must not leave a feature on silently.
- An admin can't turn on at runtime a feature this variable turns off.

## Layer 2: an admin's runtime pause (no redeploy)

For an emergency. It takes effect at once on the server that handles the request and **within 10 seconds** everywhere else (`FEATURE_FLAG_CACHE_MS`). The app rechecks every minute, and when the tab regains focus, to show or hide the banner and the greyed-out buttons.

You need an admin account on that environment (`users.role = ADMIN`; see "Calling the admin endpoints" in `docs/observability.md`). Signed in on the site (e.g. `https://dev.klecx.com`), open the browser's developer tools → **Console** and run:

```js
// See every switch, whether it's on, and why it's off.
await (await fetch("/api/v1/admin/features")).json()

// Pause all AI calls (the kill switch). The reason is an internal note, never shown to users.
await (await fetch("/api/v1/admin/features/ai", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ enabled: false, reason: "provider outage" }),
})).json()

// Turn it back on.
await (await fetch("/api/v1/admin/features/ai", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ enabled: true }),
})).json()
```

Replace `ai` with any key from the table. Each answer shows `enabled` (what the app does now), `disabledByEnv` (off through `DISABLED_FEATURES`: change the variable and redeploy instead) and `paused` (who paused it, when and why).

Every change is written to `audit_logs` (`FEATURE_PAUSED` / `FEATURE_RESUMED`, `target_id` = the key) and logged as `feature flag changed`. The pauses themselves are rows in `feature_flags` (a row means "off"). Deleting a row by hand also resumes the feature, within 10 seconds.

If the database can't be read, each server keeps the last pauses it knew about.

## When to use which

| Situation | Do this |
| --- | --- |
| The AI provider is down or answers with errors | Pause `ai`, put a note on the status page, resume when it's back. |
| Costs climb faster than expected (an alert from `docs/observability.md`) | Pause `ai` first, find the cause (`GET /api/v1/admin/metrics`), then suspend the account or freeze its credits (`ADMIN_CONSOLE.md` §14) and resume. |
| The web-search provider is down or near its daily cap | Pause `webSearch`. |
| Invitation or share-link spam | Pause `collaboration`, suspend the accounts involved, resume. |
| A wave of fake sign-ups, or the beta is full | Pause `signups`. |
| A billing bug or a problem at the payment provider | Pause `checkout`; renewals and webhooks keep working. |
| A feature should stay off on one environment | `DISABLED_FEATURES` there. |

## For developers

- Server: `await assertFeature("collaboration")` (503 `feature_paused` when off), `await assertAiFeature("documentReview")` (the kill switch, then the feature's own switch), `await isFeatureOn("webSearch")` to just skip something. Check **after** authorization (a stranger must still get 404) and **before** reserving credits or calling a provider.
- Every AI call that reserves credits through `reserveForWorkspaceGeneration()` is also refused there when `ai` is paused: a safety net for new AI features.
- Browser: `useFeatureFlags()` (`lib/api/hooks/features.ts`) gives `{ ai, webSearch, … }` from `GET /api/v1/features` (signed-in only; booleans, never reasons). Grey out a control with `<Gated reason={{ code: "paused" }}>`.
- A new switch: add the key to `FEATURE_KEYS` with a comment, check it in the service, list it in the table above, in `README.md` (`DISABLED_FEATURES`) and in `.env.example`.
- Tests: under Jest the runtime pauses are read only in a test file that calls `enableRuntimePausesForTesting(true)`, because the test workers share one database. See `__tests__/step-10-6-feature-flags.test.ts`.
