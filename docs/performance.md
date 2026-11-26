# Performance (Step 10.5)

## Targets and how they're checked

| Target | Checked by | Result (2026-11-26, test build, desktop preset, median of 3) |
| --- | --- | --- |
| Marketing: performance ≥ 90, accessibility ≥ 95, SEO ≥ 95 (LCP < 2.5 s, CLS < 0.1 are part of the performance score) | `npm run lighthouse` (`scripts/lighthouse.mjs`), the `lighthouse` job of `.github/workflows/e2e.yml` | `/`, `/pricing`, `/features`: 100 / 100 / 100; `/help`: 100 / 98 / 100 |
| Sign-in: performance ≥ 90, accessibility ≥ 95 (no SEO target: the page is `noindex` on purpose) | same | `/auth/login`: 98 / 98 |
| App: accessibility ≥ 95 | same (signed in through the test inbox) | `/workspaces` 100, `/settings/profile` 98, `/settings/usage` 98 |

Run it locally: `npm run e2e:build`, then `npm run lighthouse` (it starts the build on port 3100 if nothing answers there). Reports: `.lighthouseci/reports/<group>/*.report.html`. In CI they're uploaded as the `lighthouse-reports` artifact. Scores on shared CI machines vary by a few points; a failure just above the line is worth re-running before investigating.

## What loads when

- **KaTeX** (≈ 280 KB of script plus its stylesheet and fonts) loads only when a text contains a `$` (remark-math's delimiter): `lib/markdown/katex-loader.ts`. Until it arrives (first formula of the session), the formula shows as its TeX source for a moment.
- **Shiki** (code highlighting) was already loaded on the first code block (`components/markdown/code-block.tsx`).
- **react-easy-crop** (avatar cropper) loads when a picture is chosen (`next/dynamic` in `components/settings/UserProfileImage.tsx`).
- Mermaid and Recharts named by the guide aren't used (charts are hand-drawn SVG since Step 9.3).
- **Bundle analysis:** `npm run analyze` (Next.js's built-in analyzer, `next analyze`, Turbopack builds; no extra dependency). Look for libraries in the shared chunks that only one page needs.

## Database: hot queries

Measured with `auto_explain` (every query's real plan and time) on a seeded copy: 20,000 people, 200,000 workspaces, 100,000 memberships, 500,000 responses and versions, 1,000,000 ledger rows, 300,000 annotations. The person measured owns 400 workspaces and is a member of 50.

| Query (service) | Before | After | Plan |
| --- | --- | --- | --- |
| List workspaces (`listWorkspaces`, the sidebar) | **124 ms** | **≈ 5 ms** | was a scan of every workspace (the OR over owner / member / project can't use one index) plus a count of the members of **every** workspace (`_count`); now memberships and project ids are looked up first (index), the list is a BitmapOr of `(ownerId, deletedAt, lastActivityAt)`, the primary key and `projectId`, and members are counted for the page only |
| Responses of a workspace (`listWorkspaceResponses`) | < 1 ms | — | index `(workspaceId, deletedAt, sortAt, id)` |
| Credit history (`listCreditHistory`) | < 1 ms | — | index `(account_id, created_at)` |
| Annotations of a response (`listAnnotationsForResponse`) | 2.4 ms | — | index `(response_id)`; messages by `(annotation_id, created_at)` |

No new index was needed: the ones from earlier steps cover these queries. No N+1 query showed up on these paths: each page is a fixed number of queries, whatever the number of rows (Prisma loads relations in one query per relation).

To repeat the measurement:

```bash
psql -h localhost -p 55432 -U postgres -c "create database klecx_perf"
```

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:55432/klecx_perf" npx prisma migrate deploy
```

```bash
psql -h localhost -p 55432 -U postgres -d klecx_perf -f scripts/perf/seed.sql
```

```bash
psql -h localhost -p 55432 -U postgres -c "alter database klecx_perf set session_preload_libraries='auto_explain'" -c "alter database klecx_perf set auto_explain.log_min_duration=0" -c "alter database klecx_perf set auto_explain.log_analyze=on"
```

Then call the services against `klecx_perf` (for example from a throw-away Jest test with `DATABASE_URL` pointing at it, as person `u1`, workspace `w500`, response `r1`) and read the plans in the Postgres log. Drop the database afterwards.

## Caching

- **Help articles** are parsed once per language and kept in memory in production (`lib/help/articles.ts`); development and tests read the files each time.
- **Marketing pages are rendered per request**: the language comes from a cookie (or the account), so a shared cache would serve one person's language to another. With the per-language URLs of Step 10.7 they can become static or cached at the edge; until then they're cheap to render and score 100 on performance.
- Images: the only `next/image` on a public page (404) has fixed width and height (no layout shift); marketing pages use inline SVG and CSS.
