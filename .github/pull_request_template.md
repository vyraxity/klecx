## What this PR does

<!-- Step or fix (e.g. "Step 10.1 — Security hardening pass"), and a short summary. -->

## Checks

- [ ] Every **new endpoint that takes an id** has its row in `__tests__/authz/step-10-1-two-user-suite.test.ts` (a stranger gets 404). The coverage test there fails otherwise.
- [ ] New routes use `route()` (origin check, body limit, rate limit) or are listed as an exception in `__tests__/step-10-1-security-hardening.test.ts`, with the reason.
- [ ] All user-visible text is in `messages/en.json`, `es.json` and `fr.json`.
- [ ] No secrets, prompts, responses or file contents in logs; no real values in `.env.example` or docs.
- [ ] Schema changes come with a migration.
- [ ] New dependencies: one-line reason below.

## Left for the owner

<!-- Dashboard steps, decisions, anything not done here. -->
