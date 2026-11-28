# Klecx

Klecx is an AI workspace by **Vyraxity** (Lagos, Nigeria). People ask questions in **workspaces** (grouped into **projects**), keep every **version** of an answer, highlight a passage to **comment** on it or **ask** a follow-up question about it (nested without limit), add documents, invite collaborators with roles, share read-only links, and pay with monthly **credits** on the Free, Lite, Standard and Pro plans.

This README is for **people working on the code**: what it's built with, how it's laid out, the house rules, and how to run it on your machine. The product decisions and the plan live in [`CLAUDE.md`](CLAUDE.md) and the guides it points to; detailed topics live in [`docs/`](docs).

## Contents

1. [Stack](#stack)
2. [Code layout](#code-layout)
3. [House rules](#house-rules)
4. [Prerequisites and accounts](#prerequisites-and-accounts)
5. [Local setup](#local-setup)
6. [Tests](#tests)
7. [Environment variables](#environment-variables)
8. [Deploying](#deploying)
9. [More documentation](#more-documentation)

## Stack

| Area | What |
| --- | --- |
| App | Next.js 16 (App Router), React 19, TypeScript |
| UI | Tailwind CSS 4, shadcn/ui (Radix), our own design tokens (`docs/design.md`) |
| Data | PostgreSQL 16, Prisma 7 (client generated into `server/db/generated`, not committed) |
| Sign-in | Better Auth: email and password (with optional two-factor), Google, GitHub |
| Client state | TanStack Query (server data), Zustand (UI state) |
| Languages | next-intl: English, Spanish, French (`messages/*.json`, help in `content/help/<locale>/`) |
| AI | the provider's API behind our own interface (`server/ai/`), streamed to the browser with SSE |
| Files | Cloudinary (an in-memory mock when it isn't configured) |
| Email | Resend (printed to the console in development) |
| Rate limits | Upstash Redis (in memory when it isn't configured) |
| Billing | Creem, merchant of record (off until go-live: `BILLING_ENABLED`) |
| Monitoring | pino JSON logs, Sentry (optional) |
| Tests | Jest, Playwright, Lighthouse CI, k6 |
| Hosting | Vercel; background jobs called by GitHub Actions |

## Code layout

```
app/               routes
  (marketing)/     public pages (home, pricing, features, help, legal)
  (app)/           the signed-in app (workspaces, projects, settings…)
  api/v1/          JSON and SSE endpoints the UI calls
  api/cron/        background jobs (docs/background-jobs.md)
  api/webhooks/    Creem webhooks
  s/[token]/       public share pages
server/            server-only code (`import "server-only"`)
  services/        business rules: one place per feature
  authz/           roles and permissions
  ai/              provider, model registry, prompts, context builder
  billing/         plans, entitlements, Creem client, webhook state machine
  email/ storage/ speech/ jobs/ monitoring/
  http/            route() wrapper, errors, rate limits
  env.ts           every server environment variable, validated with zod
lib/               code shared by server and browser
  schemas/         zod request schemas
  api/             fetch client and TanStack Query hooks
  stores/          Zustand stores
components/        React components
messages/          translations (en, es, fr)
content/help/      help center articles (MDX, per language)
prisma/            schema.prisma and migrations
__tests__/         Jest tests
e2e/               Playwright journeys
scripts/           build, check and maintenance scripts
docs/              topic guides (testing, security, observability, …)
```

## House rules

The full list is in [`CLAUDE.md`](CLAUDE.md) ("Rules for every change"). The short version:

1. **The server decides.** Never trust a user id, role, plan, balance, price or model sent by the browser. A route parses, authenticates, authorizes, calls a service and shapes the answer (`route()` in `server/http`).
2. **Prisma only in `server/`.** The UI talks to `/api/v1/*`.
3. **Every new resource gets an authorization check and a test that another person gets 404**, including a row in the two-user suite (`__tests__/authz/`).
4. **Every visible text goes through next-intl**, in en, es and fr (labels, `aria-label`, toasts, emails, help, legal). `npm run check:i18n` checks it.
5. **No hard-coded emails, company details or URLs:** use `getSiteConfig()`. No third-party AI brand names in product copy.
6. **Copy must be true:** don't describe a feature that doesn't exist yet.
7. **Tests ship with the feature.**
8. **No secrets, prompts, answers or file contents in logs.** Use `log` from `server/log.ts`, not `console.*`.
9. **Every stored file goes under `CLOUDINARY_UPLOAD_FOLDER`** (`storagePath(...)`).
10. **Never edit a merged migration.** Create a new one (see step 6 below).

Branches start from `dev` (the default branch). Branch names describe the work, for example `step/9-2-preferences-theme-locale` or `fix/F1-2-member-capabilities`. Only the owner merges into `dev` and `main`.

## Prerequisites and accounts

**On your machine**

- **Node.js 22 or newer** (`.nvmrc` says 22) and npm.
- **PostgreSQL 16**: Docker (`docker compose up -d` starts the one in `docker-compose.yml`) or a local install.
- Git. Optional: [Gitleaks](https://github.com/gitleaks/gitleaks) (the secret scan CI runs), the [Creem CLI](https://docs.creem.io) (to forward test webhooks).

**Accounts.** None is needed to start. Add one only when you work on what it powers.

| Service | Needed for | Without it, locally |
| --- | --- | --- |
| Google AI Studio (API key) | real AI answers, voice input, natural read-aloud | `AI_PROVIDER="fake"` gives canned answers |
| Resend | sending real emails | emails and their links are printed in the terminal |
| Cloudinary | real file uploads | an in-memory mock (files are lost on restart) |
| Upstash Redis | shared rate limits | in-memory rate limits |
| Google Cloud / GitHub OAuth apps | "Continue with Google / GitHub" | email-and-password sign-in only |
| Creem (test mode) | checkout, plan changes, webhooks | billing stays off; `DEV_DEFAULT_PLAN` picks your plan |
| Sentry | error tracking | errors only in the logs |

## Local setup

1. **Clone the repository and start from `dev`.**

   ```bash
   git clone https://github.com/vyraxity/klecx.git
   ```

   ```bash
   cd klecx && git checkout dev
   ```

2. **Start PostgreSQL.** With Docker:

   ```bash
   docker compose up -d postgres
   ```

   That creates the database `klecx_v2_dev` (user `postgres`, password `postgres`, port 5432), which is what `.env.example` points at. With your own Postgres, create an empty database and use its URL in the next step.

3. **Create `.env.local`** from the example and fill in the required values:

   ```bash
   cp .env.example .env.local
   ```

   - `BETTER_AUTH_SECRET`: at least 32 random characters, e.g. `openssl rand -base64 48`.
   - `GEMINI_API_KEY`: your key. To start without one, keep the placeholder and set `AI_PROVIDER="fake"` (canned answers).
   - `RESEND_API_KEY`: the example's `re_dev_placeholder` prints emails in the terminal instead of sending them. Put a real key only to send real emails.
   - Leave the OAuth, Cloudinary, Upstash, Creem and Sentry values empty until you need them. An empty value counts as "not set"; a `CHANGE_ME` doesn't.

   The [table below](#environment-variables) explains every variable. `.env.local` is git-ignored: **never commit real values** (the repository is public).

4. **Install the dependencies.** `postinstall` generates the Prisma client, so `DATABASE_URL` must be readable (it is, from `.env.local`).

   ```bash
   npm ci
   ```

5. **Apply the migrations and generate the Prisma client.**

   ```bash
   npx prisma migrate deploy
   ```

   ```bash
   npx prisma generate
   ```

   Run both again **every time you pull a change to `prisma/schema.prisma`**. Otherwise new tables are missing ("Cannot read properties of undefined (reading 'create')"). Use `migrate deploy`, not `migrate dev`: `migrate dev` is for *creating* migrations and can offer to reset a drifted database.

6. **Creating a migration** (only when you change the schema):

   ```bash
   npx prisma migrate dev --create-only --name short_name
   ```

   Rename the new folder to the repository's style (`YYYYMMDD_short_name`, with a letter suffix for a second one the same day, e.g. `20261121b_billing_consents`), review the SQL, then run step 5. CI fails when the schema and the migrations disagree.

7. **Run the app.**

   ```bash
   npm run dev
   ```

   Open <http://localhost:3000>.

8. **Create your first user.** Sign up at <http://localhost:3000/auth/register>. With the placeholder Resend key, the terminal prints a block like this:

   ```
   📧 [Email Dev Console]
   Template: verify-email …
   Action Link: http://localhost:3000/…
   ```

   Open the link to verify the address, then sign in. Codes (e.g. adding a password) appear the same way. Without a subscription you get the plan in `DEV_DEFAULT_PLAN` (development only).

   To try the admin endpoints (`/api/v1/admin/*`), make your account an admin in the database:

   ```bash
   npx prisma studio
   ```

   Set `role` to `ADMIN` on your row in `users`.

9. **Optional: billing in test mode.** Set `BILLING_ENABLED="true"` and the `CREEM_*` values (Creem dashboard in test mode), restart `npm run dev`, and forward webhooks:

   ```bash
   creem listen --forward-to http://localhost:3000/api/webhooks/creem
   ```

   It prints a new signing secret every run: put it in `CREEM_WEBHOOK_SECRET` and restart. Test card `4111 1111 1111 1111`. Never use a product's payment link from the dashboard: the webhook can't tell who paid.

## Tests

[`docs/testing.md`](docs/testing.md) has the details. The checks CI runs:

```bash
npm run lint
```

```bash
npm run check:tokens
```

```bash
npm run check:i18n
```

```bash
npm run typecheck
```

```bash
npm run build
```

```bash
npm run check:audit
```

**Jest** needs its own database: the tests create and delete rows. Create an empty database (e.g. `klecx_test`), apply the migrations to it, and run the tests with dummy values. Jest doesn't read `.env.local`.

```bash
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/klecx_test" APP_URL="http://localhost:3000" GEMINI_API_KEY=ci-dummy-key-0000 RESEND_API_KEY=re_ci_dummy EMAIL_FROM="Klecx <ci@example.com>" BETTER_AUTH_SECRET="ci-dummy-auth-secret-min-32-chars-long!"
```

```bash
npx prisma migrate deploy && npm test -- --ci
```

`npm run test:coverage` also checks at least 80 % line coverage in `server/services`. `npm run verify` runs everything in one go with a throwaway Postgres in Docker.

**End-to-end (Playwright).** These run a production build in **test mode**: fake AI, a test inbox instead of emails, fake Creem, mock storage, and a separate database.

1. Add `E2E_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/klecx_e2e"` to `.env.local`. Never use your development database: the journeys fill it with test people. The build creates the database if it doesn't exist.
2. Install the browsers (once):

   ```bash
   npx playwright install chromium webkit
   ```

3. Build, then run the journeys (rebuild after changing app code):

   ```bash
   npm run e2e:build
   ```

   ```bash
   npm run e2e
   ```

   One file: `npx playwright test e2e/07-billing.e2e.ts`; one browser: `--project=chromium`; to watch it, add `--headed`.

Then `npm run lighthouse` checks the Lighthouse targets ([`docs/performance.md`](docs/performance.md)) and `npm run analyze` opens the bundle analyzer. The load test (k6) is described in `docs/testing.md`.

## Environment variables

Every server variable is declared and validated in [`server/env.ts`](server/env.ts). A wrong value stops the app at start with a list of what's wrong. `.env.example` lists them with safe defaults. An **empty value counts as unset**.

"Required" means the app won't start without it. "Production" means required when `NODE_ENV=production` (on Vercel). Values are read at start, so restart `npm run dev` after a change. **`NEXT_PUBLIC_*` variables are built into the browser code:** rebuild after changing them, and never put a secret in one.

### Core (required)

| Variable | What it does | Where to get it |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection the app uses. | Your local Postgres (`postgresql://postgres:postgres@localhost:5432/klecx_v2_dev`) or the hosting database. One database per environment. |
| `APP_URL` | The site's public address, without a trailing slash: links in emails, OAuth callbacks, the allowed origin for writes, canonical URLs. (`DOMAIN` is still read as an old alias.) | `http://localhost:3000` locally; `https://dev.klecx.com` / `https://klecx.com` on Vercel. |
| `BETTER_AUTH_SECRET` | Signs sessions and encrypts sign-in secrets. At least 32 characters. Changing it signs everybody out. (`AUTH_SECRET` is still read as an old alias.) | Generate it: `openssl rand -base64 48`. A different value per environment. |
| `GEMINI_API_KEY` | The AI provider's key: answers, Asks, reviews, titles, voice input, web search, natural read-aloud. | Google AI Studio → API keys. Restrict it and set quota alerts in production. Locally, any 10+ characters with `AI_PROVIDER="fake"`. |
| `RESEND_API_KEY` | Sends emails. Must start with `re_`. In development, a key containing `dummy` or `placeholder`, or starting with `re_dev`, prints emails in the terminal instead. | Resend → API Keys. Locally `re_dev_placeholder`. |
| `EMAIL_FROM` | The "From" of every email, e.g. `Klecx <hello@klecx.com>`. | A sender on a domain verified in Resend. For a first test, Resend allows `onboarding@resend.dev`. |

### AI models

All optional. The defaults in `server/env.ts` are older model names, so set them.

| Variable | What it does | If unset |
| --- | --- | --- |
| `GEMINI_TEXT_MODEL_ECONOMY` | Model of the **Fast & Efficient** tier (all plans). Credits are priced for `gemini-3.1-flash-lite` (`lib/ai/model-catalog.ts`): use that model. | `GEMINI_TEXT_MODEL`, else an old default. |
| `GEMINI_TEXT_MODEL_STANDARD` | Model of the **Standard Reasoning** tier (paid plans). Credits are priced for `gemini-3.8-flash`: use that model. | An old default that new API keys can't use: Standard answers fail. |
| `GEMINI_TEXT_MODEL` | Older single-model setting; only a fallback for the economy model. | Not needed when `GEMINI_TEXT_MODEL_ECONOMY` is set. |
| `GEMINI_IMAGE_MODEL` | Image generation model. Images are off at launch (`NEXT_PUBLIC_IMAGE_GENERATION_ENABLED`). | An old default. Only matters when images are turned on. |
| `AI_TRANSCRIBE_MODEL` | Voice input (speech to text). Must accept audio. | The economy text model. |
| `GEMINI_TTS_MODEL` | Natural-voice read-aloud (text to speech). | `gemini-3.8-flash-lite-tts`. |

### Site identity and contact addresses

Shown on legal pages, emails, the footer and `security.txt`, read through `getSiteConfig()`. Optional in development; the first six rows are **required in production**.

| Variable | What it does | If unset |
| --- | --- | --- |
| `SUPPORT_EMAIL` | Support address (footer, help, emails, legal). **Production.** | `support@example.test` |
| `PRIVACY_EMAIL` | Privacy requests (Privacy Policy). **Production.** | `privacy@example.test` |
| `ABUSE_EMAIL` | Abuse reports (Acceptable Use Policy). **Production.** | `abuse@example.test` |
| `COMPANY_LEGAL_NAME` | Company named in the legal pages and email footer. **Production.** | `Vyraxity` |
| `COMPANY_ADDRESS` | Company address in the legal pages. **Production.** | `Lagos, Nigeria` |
| `COMPANY_COUNTRY` | Country code of the company. **Production.** | `NG` |
| `LEGAL_EMAIL` | Legal notices (Terms). | `SUPPORT_EMAIL` |
| `BILLING_EMAIL` | Billing questions; also receives dispute alerts and webhooks that match nobody. | `SUPPORT_EMAIL` |
| `SECURITY_EMAIL` | Security reports, in `/.well-known/security.txt`. | `SUPPORT_EMAIL` |
| `ALERTS_EMAIL` | Monitoring alerts (provider errors, costs, failed jobs, billing drift). | `BILLING_EMAIL` |
| `COMPANY_REG_NUMBER` | Company registration number (e.g. the CAC number). Passed to the site configuration; no page displays it yet. | Nothing changes. |
| `COMPANY_WEBSITE` | The company's website (footer, legal). | `https://vyraxity.com` |
| `SOCIAL_X_URL`, `SOCIAL_GITHUB_URL` | The company's X and GitHub profiles, listed in the structured data search engines read (`sameAs`). | Left out of it. |
| `STATUS_PAGE_URL` | An external status / incident page; `/status` links to it. | `/status` shows only the app's own health checks. |

### Sign-in with Google and GitHub

Optional. Without them only email-and-password sign-in is offered. Set both values of a provider.

| Variable | Where to get it |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Cloud Console → APIs & Services → Credentials → OAuth client ID (Web). Redirect URI: `<APP_URL>/api/auth/callback/google`. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub → Settings → Developer settings → OAuth Apps. Callback URL: `<APP_URL>/api/auth/callback/github`. |

Use one OAuth app per environment: the redirect address differs.

### File storage (Cloudinary)

Set the three keys together, or none.

| Variable | What it does | If unset |
| --- | --- | --- |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Stores uploads, avatars, documents, exports and read-aloud audio. From Cloudinary → Settings → API Keys. | An **in-memory mock**: uploads seem to work but vanish on restart. Don't deploy without them. |
| `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME` | Cloud name for the browser. | `CLOUDINARY_CLOUD_NAME`. |
| `CLOUDINARY_UPLOAD_FOLDER` | The folder every file goes under, one per environment (`klecx/dev`, `klecx/preview`, `klecx/prod`). | `klecx/dev` |
| `CLOUDINARY_FOLDER_MODE` | `dynamic` (newer accounts) or `fixed`. In dynamic mode uploads also send `asset_folder` so files show in their folder. | Asked once from Cloudinary's Admin API, else `fixed`. |

### Rate limits (Upstash Redis)

| Variable | What it does | If unset |
| --- | --- | --- |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Rate limits shared by every server instance. From Upstash → your Redis database → REST API. Set both or neither. **Production.** | In-memory limits per instance; fine for development. |
| `TRUST_PROXY` | `true` reads the visitor's IP from `X-Forwarded-For` / `X-Real-IP` for per-IP limits. Only behind a proxy that overwrites those headers (Vercel does). | `false`: those headers are ignored. |

### Billing (Creem)

Billing stays hidden until `BILLING_ENABLED=true`. Test mode first: the live store, key and webhook come only at go-live. When billing is on in production, **every** `CREEM_*` value and `BILLING_PROVIDER` are required.

| Variable | What it does | Where to get it / if unset |
| --- | --- | --- |
| `BILLING_ENABLED` | `true` shows prices, checkout, plan changes and billing text. | Unset or `false`: Plan & billing hides every action and the pricing page says "Coming soon". |
| `BILLING_PROVIDER` | `creem` (the only one). | — |
| `CREEM_API_BASE` | `https://test-api.creem.io` (test) or `https://api.creem.io` (live). | Creem docs. |
| `CREEM_API_KEY` | Creem API key. **Secret.** | Creem dashboard → Developers (with the Test Mode toggle on for the test key). |
| `CREEM_WEBHOOK_SECRET` | Checks the signature of webhooks at `/api/webhooks/creem`. **Secret.** | Creem dashboard → Developers → Webhooks, or the secret `creem listen` prints locally. Unset: webhooks are refused. |
| `CREEM_PRODUCT_LITE_MONTH`, `CREEM_PRODUCT_LITE_YEAR`, `CREEM_PRODUCT_STANDARD_MONTH`, `CREEM_PRODUCT_STANDARD_YEAR`, `CREEM_PRODUCT_PRO_MONTH`, `CREEM_PRODUCT_PRO_YEAR` | The six products (each plan, monthly and yearly), `prod_…`. | Creem dashboard → Products. Prices must match `PLANS` in the code. |
| `DEV_DEFAULT_PLAN` | `FREE`, `LITE`, `STANDARD` or `PRO`: the plan of accounts without a subscription, to try paid features locally. | Free. **Ignored in production.** |

### Background jobs

| Variable | What it does | If unset |
| --- | --- | --- |
| `CRON_SECRET` | Bearer token the scheduler sends to `/api/cron/<job>`. At least 32 random characters (`openssl rand -base64 48`), different per environment. | Every job call is refused (401): nothing reaps stuck AI calls, retries emails or erases deleted data. Fine locally. |

The scheduler is the GitHub Actions workflow `.github/workflows/cron.yml`. It needs these repository settings: variables `CRON_BASE_URL` and optionally `CRON_PREVIEW_BASE_URL`; secrets `CRON_SECRET`, `CRON_PREVIEW_SECRET`, `VERCEL_AUTOMATION_BYPASS_SECRET` (while deployment protection is on), and `SYNTHETIC_EMAIL` / `SYNTHETIC_PASSWORD` (a test account for the hourly sign-in check). Details: [`docs/background-jobs.md`](docs/background-jobs.md).

### Monitoring

| Variable | What it does | If unset |
| --- | --- | --- |
| `LOG_LEVEL` | `fatal`, `error`, `warn`, `info` or `debug`. | `info` |
| `NEXT_PUBLIC_SENTRY_DSN` | Turns Sentry error tracking on (the DSN is public). From Sentry → project → Client Keys. | Sentry is off; errors only in the logs. |
| `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | Share of requests traced, 0 to 1. | `0`: errors only. |
| `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` | Upload source maps at build time (Vercel only; the token is a secret). | Stack traces show built code. |

Setup steps: [`docs/observability.md`](docs/observability.md).

### Switches

| Variable | What it does | If unset |
| --- | --- | --- |
| `NEXT_PUBLIC_IMAGE_GENERATION_ENABLED` | `true` turns image generation on. **Keep it off** until Creem has approved the store and its image requirements are built (`CLAUDE.md`, "Text-only launch"). Built into the code: rebuild. | Off: text only. |
| `CSP_REPORT_ONLY` | `true` sends the Content-Security-Policy as report-only, an emergency switch if it blocks something after a deploy. | Enforced. |
| `PWNED_PASSWORD_CHECK` | `false` turns off the breached-password check at sign-up and password change. | On (only a 5-character hash prefix leaves the server). |
| `MAINTENANCE_MODE` | `true` sends every page to `/maintenance` (health checks and `/status` still answer). | Off. |
| `MARKETING_LOCALE_URLS` | Per-language marketing URLs. Not ready yet (Step 10.7): leave it unset. | One URL per page. |

### Database tools and builds

| Variable | What it does | If unset |
| --- | --- | --- |
| `DIRECT_URL` | A non-pooled database URL for the Prisma CLI (migrations), when `DATABASE_URL` goes through a transaction-mode pooler. | The CLI uses `DATABASE_URL`. |
| `MIGRATE_ON_PREVIEW` | `true` lets a **Vercel preview** build run `prisma migrate deploy`. Set it for the `dev` branch only, so unmerged PRs don't migrate the preview database. Production and local builds always migrate. | Preview builds skip migrations. |

### Tests only

Never set these on a real deployment.

| Variable | What it does |
| --- | --- |
| `AI_PROVIDER` | `fake`: deterministic answers without any network call (also fake voice). Refused in production (outside a local test build) and on Vercel. Unset: the real provider. |
| `E2E_TEST_MODE` | `true`: test inbox, fake Creem, mock storage, in-memory rate limits, `/api/test/*`. Refused whenever `VERCEL` is set. `npm run e2e:build` sets it for you. |
| `E2E_DATABASE_URL`, `E2E_PORT` | Database and port of the end-to-end runs (read from the environment, `.env` or `.env.local`). Default `postgresql://postgres:postgres@localhost:55432/klecx_e2e` and `3100`. |
| `PW_CHROMIUM_PATH`, `CHROME_PATH` | A Chromium binary for Playwright / Lighthouse instead of Playwright's own. |
| `I18N_UNUSED` | `warn` or `list` makes `check:i18n` report unused translation keys instead of failing. |
| `I18N_CHECK_ROOT`, `HELP_CONTENT_DIR` | Let a test run `check:i18n` or the help center on a temporary copy of the files. |

### Set by the platform

Don't set these yourself: `NODE_ENV`, `NEXT_PHASE`, `NEXT_RUNTIME` (Next.js), `VERCEL`, `VERCEL_ENV`, `NEXT_PUBLIC_VERCEL_ENV`, `VERCEL_GIT_COMMIT_SHA` (Vercel: the environment name and release in logs and Sentry), `CI` (GitHub Actions).

## Deploying

- **Three environments:** local, **preview** (the `dev` branch at `dev.klecx.com`, test mode), **production** (`main` at `klecx.com`). Each has its own database, Cloudinary folder, secrets and OAuth apps.
- Environment variables live in Vercel → Project → Settings → Environment Variables (Preview and Production separately). `npm run build` generates the Prisma client and applies migrations before `next build` (preview: only with `MIGRATE_ON_PREVIEW=true`).
- Background jobs, monitoring and go-live steps: [`docs/background-jobs.md`](docs/background-jobs.md), [`docs/observability.md`](docs/observability.md), [`docs/compliance/creem-application.md`](docs/compliance/creem-application.md).

## More documentation

| Document | About |
| --- | --- |
| [`CLAUDE.md`](CLAUDE.md) | the plan, the rules for every change, and every product decision |
| [`docs/api.md`](docs/api.md) | the `/api/v1` endpoints |
| [`docs/design.md`](docs/design.md) | design tokens and UI conventions |
| [`docs/testing.md`](docs/testing.md) | test layers, test mode, flake policy |
| [`docs/security-review.md`](docs/security-review.md) | security review and open gaps |
| [`docs/observability.md`](docs/observability.md) | logs, Sentry, metrics, alerts |
| [`docs/background-jobs.md`](docs/background-jobs.md) | scheduled jobs and their setup |
| [`docs/performance.md`](docs/performance.md) | performance budgets, Lighthouse |
| [`docs/accessibility.md`](docs/accessibility.md) | accessibility rules, screen-reader checklist |
| [`docs/compliance/`](docs/compliance) | Creem application, abuse prevention |
| [`ADMIN_CONSOLE.md`](ADMIN_CONSOLE.md) | what the future admin console must do |
| [`OPEN_DECISIONS.md`](OPEN_DECISIONS.md) | product questions not decided yet |
| [`MOBILE_UPGRADE.md`](MOBILE_UPGRADE.md) | mobile and PWA work planned after launch |

Klecx is a product of Vyraxity.
