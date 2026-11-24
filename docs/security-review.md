# Klecx security review (Step 10.1)

Checked on 2026-11-23 against the code on `step/10-1-security-hardening`. **Re-check before launch (Step 10.6)** and whenever a step adds endpoints, uploads, sign-in methods or third-party calls.

Status: **Pass** (control in place and tested), **N/A** (doesn't apply to Klecx), **Gap** (open; owner or a later step). The open gaps are listed first.

## Open gaps

| # | Gap | Who / when |
| --- | --- | --- |
| ~~G1~~ | ~~Two-factor sign-in~~ — **closed 2026-11-23**: TOTP + backup codes, trusted devices, Settings → Security (see API2). It covers email-and-password sign-in; Google/GitHub sign-ins rely on that account's own two-step verification (`OPEN_DECISIONS.md` §16). | Done |
| G2 | **External review**: someone other than the author tries to break sharing, invitations and the billing webhook (guide "Done when"). Suggested scope and rules: the "Reporting security issues" section of the Acceptable Use Policy; test on `dev.klecx.com` with test accounts only. | Owner, before launch |
| G3 | **Key rotation and separation**: new Gemini, Creem, Cloudinary, Resend, Upstash and `BETTER_AUTH_SECRET` values for production, different from preview and local; Gemini key restricted to the Generative Language API with quota alerts on. | Owner, Step 10.6 |
| G4 | **Old secrets in git history** (CLAUDE.md, from Step 8.3): rotate/confirm unused, then add the fingerprints to `.gitleaksignore`. | Owner, before applying to Creem |
| ~~G5~~ | ~~Structured logging and alerts~~ — **closed in Step 10.2**: JSON logs with redaction, Sentry (once configured), business metrics and alerts (`docs/observability.md`). The hourly alert run comes with Step 10.3. | Done |
| G6 | **Antivirus scanning of uploads** isn't done. Risk is low today: files are only parsed as text (10 s timeout, page and size caps), never executed or served inline from our origin, and downloads are `attachment` with a sandbox CSP. Revisit if Klecx ever serves uploaded files to other people inline. Recorded in `OPEN_DECISIONS.md` §15. | Owner decides |

## OWASP API Security Top 10 (2023)

| Risk | Status | Evidence |
| --- | --- | --- |
| API1 Broken object-level authorization | **Pass** | Two-user suite `__tests__/authz/step-10-1-two-user-suite.test.ts`: a stranger gets 404 on 110 cases covering every id-scoped endpoint (workspace, project, response, version, edit, annotation at every depth, messages, notes, attachment, document + revisions + downloads + reviews, share, notification, session, invitation, ownership transfer, generation, question batch, export, linked accounts, read-aloud targets, admin routes) and A's data is unchanged afterwards; a coverage test fails when a new `[param]` route has no row. Role matrix: `__tests__/authz/matrix.test.ts` (Appendix A). Found and fixed here: `POST /attachments/:id/complete` returned another person's finished attachment (with its extracted text) to anyone with the id. |
| API2 Broken authentication | **Pass** | Better Auth: email verification required, password 10–128 chars, scrypt hashes, sessions 30 days with daily rotation, revocation on password change, fresh sign-in for sensitive actions (Steps 1.3, 1.4, 7.3, 9.1). Sign-in 5/min per IP + email, sign-up 5/h per IP, reset 3/h (fail closed). **New:** passwords found in known breaches are refused at sign-up, reset and change (k-anonymity, fail open) — `server/auth/pwned-passwords.ts`. Throwaway inboxes refused. Suspended/deleted accounts can't sign in. **Two-factor sign-in** (opt-in): authenticator-app code or one-time backup code after the password (`server/services/two-factor.ts`, `/auth/two-factor`); 5 tries per challenge, a 10-minute challenge, a temporary lock after repeated failures, 10 tries per 10 minutes per IP; turning it on/off and new backup codes need the password and are emailed and audit-logged; "trust this device" for 30 days; admins can reset it for a verified person. |
| API3 Broken object property level authorization | **Pass** | Strict zod schemas on writes (`.strict()` where a field must not be set), Prisma `select` DTOs, plan/role/price/model always decided on the server (CLAUDE.md rule 1). Username can't be changed through Better Auth's `/update-user`. |
| API4 Unrestricted resource consumption | **Pass** | Credits, daily cap and concurrency per owner (Step 8.1), per-route rate limits (`server/http/rate-limit.ts`), **new:** 1 MB JSON body cap in `route()`, max lengths added to the remaining free-text fields, mention notifications capped at 10 per author per recipient per 10 min, CSP report and favicon endpoints rate-limited per IP. Upload size per plan, extraction timeouts, read-aloud daily limit, export once per 24 h. |
| API5 Broken function level authorization | **Pass** | Admin routes check `User.role = ADMIN` (403 for others, tested in the suite). Owner-only actions (transfer, member caps, billing) checked in services. **Fixed:** ownership transfer now checks ownership before validating the recipient. |
| API6 Unrestricted access to sensitive business flows | **Pass** | Checkout needs the consent box and the server's plan/price; credits only from signed webhooks, once per payment; invitations and shares rate-limited; collaborator limits counted per owner. |
| API7 Server-side request forgery | **Pass** | `server/files/safe-fetch.ts` (Step 5.3): https only, DNS resolution checked against private ranges on every redirect, size/time/MIME limits. Favicon fetches go through it. |
| API8 Security misconfiguration | **Pass** | Headers (HSTS, nosniff, Referrer-Policy, Permissions-Policy, X-Frame-Options DENY). **New:** enforced nonce-based CSP with `strict-dynamic`, `frame-ancestors 'none'`, `object-src 'none'`, reports to `/api/csp-report`; `CSP_REPORT_ONLY=true` switches to report-only. Cookie-authenticated writes must come from `APP_URL` (`origin_mismatch`). No CORS headers anywhere (tested). Errors never return stack traces. |
| API9 Improper inventory management | **Pass** | One API under `/api/v1`, listed in `docs/api.md`; every route handler uses `route()` or is a listed exception (tested). **Removed:** the unused `POST /api/email/send-verification-email`, which let anyone send Klecx-branded emails to any address without signing in. |
| API10 Unsafe consumption of APIs | **Pass** | Creem webhooks verified by signature and replay-safe (Step 8.3); AI output rendered as sanitized Markdown, remote images limited to an allow-list; prompt-injection text in documents and notes is data, not instructions (tests in `fix-F2-3-mentions-and-notes`, `step-5-2-composer-attachments`). |

## OWASP ASVS 4.0 Level 1 (by chapter)

| Chapter | Status | Notes |
| --- | --- | --- |
| V1 Architecture | Pass | Server decides (rule 1); Prisma only in `server/`; routes: parse → authenticate → authorize → service. |
| V2 Authentication | Pass | See API2. No default accounts; generic sign-in errors; reset tokens single-use and short-lived; password change notifies by email. |
| V3 Session management | Pass | HttpOnly, SameSite=Lax, `Secure` on https (Better Auth defaults); sign-out revokes server-side; list and revoke sessions in Settings; sessions revoked on password change, suspension and deletion. |
| V4 Access control | Pass | Deny by default (`requireWorkspace` / `requireProject`, 404 for strangers); top-down inheritance (`fix-F1-1`); suspended members read-only (suite); CSRF: SameSite cookies + origin check in `route()`; Better Auth checks `trustedOrigins` for its own routes. |
| V5 Validation, sanitization, encoding | Pass | zod on every body and query; **new:** control characters stripped from all JSON strings and queries; Markdown rendered without raw HTML except sanitized document HTML; emails HTML-escape every value (`__tests__/email/step-10-1-email-escaping.test.ts`); filenames sanitized, storage paths never built from user input (random ids under `CLOUDINARY_UPLOAD_FOLDER`). |
| V6 Stored cryptography | Pass | Passwords hashed by Better Auth; share/invitation tokens stored as hashes; no custom crypto. |
| V7 Errors and logging | Pass | No stack traces to users; request ids; no prompts, responses, file contents or secrets in logs (rule 11); CSP reports keep only directive, origin and path. |
| V8 Data protection | Pass | `Cache-Control: private, no-store` on share pages and downloads; exports private with 5-minute signed links; account erasure after 30 days (Step 9.5). |
| V9 Communications | Pass | HTTPS only (HSTS preload); outbound calls https. |
| V10 Malicious code | Pass | `npm audit` (`check:audit`) and Gitleaks in CI, Dependabot for npm, Actions and the pinned Docker images. |
| V11 Business logic | Pass | Idempotency keys on generations and payments; credit ledger is append-only; webhook ordering guarded by `lastEventAt`. |
| V12 Files and resources | Pass, G6 | MIME sniffing + allow-list (Step 5.1), size limits per plan, extraction timeouts; files served from our origin are `attachment` + `nosniff` + `default-src 'none'; sandbox`; **fixed:** the favicon proxy no longer accepts remote SVG (which could carry scripts) and is sandboxed. |
| V13 API | Pass | JSON only, `Content-Type` checked by parsing; no CORS; Bearer tokens supported for future native apps (exempt from the origin check). |
| V14 Configuration | Pass, G3 | Secrets only in the host's secret store, validated at boot (`server/env.ts`); no secret in `NEXT_PUBLIC_*` (tested); Docker images pinned; `/.well-known/security.txt` (RFC 9116) with `SECURITY_EMAIL`. |

## How to repeat this review

1. `npm test -- --ci __tests__/authz __tests__/step-10-1-security-hardening.test.ts __tests__/email/step-10-1-email-escaping.test.ts`
2. Open the main pages with the browser console open and look for CSP violations (or read `csp_violation` lines in the logs).
3. `gitleaks git .` and `npm run check:audit`.
4. Walk the two tables above; update the date and any row that changed.
