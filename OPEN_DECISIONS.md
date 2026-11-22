# Open decisions — Klecx

Product decisions the owner has **not** made yet. Each entry says what the code does today, so nothing here blocks a step.

How to use this file:

- **Add** an entry when a review or a step finds a choice that is the owner's to make and the owner hasn't decided. Give it the next number.
- **Don't change the behaviour** described under "Today" until the owner decides. If a step has to touch it, keep the behaviour and say so in the PR.
- **When the owner decides**, implement it in a PR, then delete the entry (record lasting choices under "Key decisions" in `CLAUDE.md`).

Review items that are already decided and only wait for a later step live in `CLAUDE.md` ("Open review items carried forward"), not here.

---

## 1. `@klecx` inside a private Ask thread

- **Found:** 2026-11-10, review of F2.3 (PR #112).
- **Where:** `syncMentionsAndNotes` in `server/services/mentions.ts` (`canShare: false`); the notes list in `server/services/notes.ts`.

**The situation.** A member has a private Ask thread (only they can see it). Inside it they comment on a passage of the answer and write `@klecx …`.

**Today.** The comment stays private (a child can't be more visible than its private parent, an F2.2 rule). A Klecx note **is** recorded. That note is workspace-wide, like every note: its instruction and the quoted passage are sent with later prompts for everyone, and both appear in the "Klecx notes" list that every workspace member can open. "View in context" doesn't work for other members, because they can't open the private thread. `@user` mentions in a private thread are ignored (plain text, no notification).

**Why it's open.** The quoted passage comes from an answer only the author could see, so recording the note shows a piece of a private answer to the whole workspace. But the author explicitly asked Klecx to remember it, and refusing would make `@klecx` unusable in private threads.

**Options.**

| | Option | Effect |
|---|---|---|
| A | Keep it (today) | Works everywhere; the quote of a private answer becomes visible to the workspace. |
| B | Refuse | `@klecx` in a private thread returns an error ("Make the thread visible to the workspace first"). Nothing leaks; one more rule for users to learn. |
| C | Record it without the quote | The note is saved with the instruction only (shown as a general note, "View in context" hidden for others). Nothing private is shown; the note loses the passage it refers to. |
| D | Personal notes | The note applies only to the author's own prompts and is listed only for them. Cleanest privacy; needs a new note scope (schema, prompt loading, UI). |

**If nothing is decided:** stays at A.

---

## 2. Heavily styled Word files, and PDFs, as workspace documents

- **Found:** 2026-11-12, review of F3.1 (PR #118).
- **Where:** `server/files/to-markdown.ts` (`docxToMarkdown`), `lib/documents/workspace-document-types.ts`, `components/markdown/document-image.tsx`.

**The situation.** The goal of documents is: attach a file, work on it with the AI and other members (comments, Asks, quick fixes, edits by hand), then download the corrected document. Everything in that chain (highlights, the AI's context, quick fixes in F3.2/F3.3, exports) works on one Markdown text per document.

**Today.** A `.docx` is converted to Markdown once, at upload. What survives: headings, paragraphs, bold/italic/strikethrough, lists, links, tables (first row becomes the header; merged cells are spread over their columns; several paragraphs in a cell are joined with a line break). What is lost: fonts, colours, sizes, alignment, page layout, headers/footers, footnote layout, text boxes, Word equations, tracked changes and Word comments. Pictures are not imported: each becomes a placeholder box showing its description. The original file is kept and can be downloaded unchanged ("Download original"). The corrected text can be exported as Word/PDF/Markdown with Klecx's own styling, not the original's. **PDFs can't be added as documents** (owner decision 2026-11-12, see `CLAUDE.md`); they can be attached to a message.

**Why it's open.** A user who uploads a branded report gets back a plain document. Whether that matters depends on who the feature is for (drafting and reviewing content, or producing the final formatted file).

**Options.**

| | Option | Effect |
|---|---|---|
| A | Keep it (today) | Content-first. Simple, every feature works on every document. Say so in the UI at upload ("Formatting is simplified; the original file is kept"). |
| B | A + import pictures | Store the file's pictures as attachments and show them in place. Medium work (storage, limits, share pages, exports). Styling is still lost. |
| C | A + "apply to original" on download | On download, write the corrected text back into the original `.docx` paragraph by paragraph, keeping each paragraph's style. Keeps the look for text edits; fragile when paragraphs are added, removed or tables change. Large work; needs its own step. |
| D | Rich-text documents | Store documents as styled HTML (or a block model) instead of Markdown, with a rich editor. Highest fidelity; changes highlights, AI context, quick fixes and exports. A redesign, not a fix. |
| E | PDFs: show the pages, annotate the text | Render the PDF pages with a text layer and anchor highlights to page + text. Faithful view, but a second anchoring model and no editing or corrected download. Only worth it if PDFs must be reviewable. |

**If nothing is decided:** stays at A, PDFs stay blocked. Recommended next step if fidelity matters: B first (cheap, visible), then C as a dedicated step after F3.3.

---

## 3. A seat-based team plan (Organization / Enterprise)

**The situation.** Collaboration is being cut back on the personal plans so that one subscription can't be shared by a group (see "collaboration limits per plan" in `CLAUDE.md`, Step 8.1). Teams that really work together then need another way to pay.

**Today.** No such plan. The owner of a workspace pays for everything in it (`CreditAccount` of the owner); collaborators are limited per plan.

**Idea from the owner (2026-11-14).** A plan billed **per seat with a minimum number of seats**, e.g. $7 per seat, at least 5 seats (example numbers).

**Questions to answer before building it:**

| # | Question | Options |
|---|---|---|
| 1 | Who owns the workspaces? | The organization (a new owner type next to users), or still a person with the org paying. The ledger already points at a `CreditAccount`, so an org account is a data-model addition (main guide §1, decision 4). |
| 2 | How are credits shared? | One pool for the organization, a pool per seat, or a pool plus a per-member cap (Step 7.5 spend caps already exist for owners). |
| 3 | What does a seat include? | The Standard or Pro features per person; whether guests (view/comment only) need a seat. |
| 4 | Billing mechanics | Seat changes mid-period (prorated with the merchant of record), minimum seats on downgrade, what happens to content when a seat is removed (same grace → read-only rule as today). |
| 5 | When | After launch, once there are teams asking for it. |


---

## 4. An owner-wide daily web search cap

**The situation.** Web search costs +3 credits per executed search, paid by the workspace owner. The daily search limit is counted **per person, per owner** (decided 2026-11-14, see "Web search" in `CLAUDE.md`): each member may run up to the owner's plan `searchesPerDay` in that owner's workspaces. With several members, the owner can pay for several times that number of searches a day (Pro, 5 collaborators: up to 6 × 200).

**Today.** No owner-wide cap. The owner's spending is already limited by:

- their credit balance (searches are paid from it, never beyond it);
- the per-member monthly credit cap the owner can set (Step 7.5, `collaborator_cap_exceeded`), which covers searches;
- the number of collaborators per plan (Step 8.1: Free/Lite 0, Standard 3, Pro 5).

Known gap: the credit hold before an answer covers the base cost only (decided 2026-11-14), so a member at their monthly cap can go over it by up to 9 credits (3 searches in one answer).

**Options.**

| | Option | Effect |
|---|---|---|
| A | No owner-wide cap (today, recommended) | Members never block each other. The owner controls spending with per-member caps. |
| B | Owner-wide cap | All searches in one owner's workspaces share one daily number (e.g. `searchesPerDay`). Caps the owner's daily search spend, but one busy member can turn search off for everyone that day, which is confusing. |
| C | A + search usage per member | Show searches (and their credits) per member in the owner's usage view, so the owner sees who spends and can set caps. Visibility, no new limit. |

**If nothing is decided:** stays at A. If owners worry about cost later, add C before considering B.

---

## 5. Moving AI calls to the provider's Interactions API

- **Found:** 2026-11-15, after the F4.4 review (PR #126) and the F4.4b thought-signature fix.
- **Where:** `server/ai/providers/gemini.ts` (the only file that calls the provider); the event types in `server/ai/types.ts`.

**The situation.** At the start of the rebranding the owner asked for the AI calls to use the provider's newer **Interactions API**. That switch was never made.

**Today.** Every AI call uses the older API: `models.generateContentStream` (main responses, Ask answers, question batches, reviews, web search tool loops), `models.generateContent` (one-off text calls) and `models.generateImages` (images). Klecx keeps the conversation itself and sends the needed history with each call, so it handles thought signatures by hand (F4.4b). Everything else in the app (billing, credits, citations, thinking summaries, tools) reads the provider-neutral events in `server/ai/types.ts`, not the provider's own format.

**Owner's direction (2026-11-15).** Switch later: after the interlude and main-guide steps are done, probably after launch. Not before.

**What to check before switching.** The aim is the same features in the app; mainly the code inside `gemini.ts` changes. The provider documentation couldn't be read from the review session, so confirm each point there first:

- **Storage and privacy.** The Interactions API can keep the conversation on the provider's servers (stateful mode). Klecx should use the **stateless** mode (send history itself, as today) unless the owner decides otherwise: stored conversations would hold users' prompts and documents with the provider, which affects the privacy policy (Nigeria Data Protection Act 2023, GDPR). Check the retention period and whether storage is on by default.
- **Feature parity.** Streaming, thinking summaries, function calling (the `web_search` and `create_document` tools), structured JSON output, attachments (images, files), safety settings and image generation must all exist there, and the `output` / usage numbers must still feed `creditsFor()` correctly.
- **New things it offers** (only if wanted): provider-side conversation state, long-running background tasks, the provider's own agents. None is needed for today's features.
- **Status and price.** Whether it is still in beta, whether prices per token are the same, and whether the model names in `GEMINI_*` env settings stay the same.
- **Thought signatures.** In stateless mode they come as separate thought steps; the F4.4b handling would be replaced, not kept.

**Options.**

| | Option | Effect |
|---|---|---|
| A | Keep the older API (today) | Works and is tested. No change. |
| B | Switch, stateless mode (recommended when switching) | Same behaviour and privacy as today; mostly a rewrite of `gemini.ts` plus its tests. |
| C | Switch, stateful mode | The provider keeps the conversation; smaller requests, but user content is stored with the provider (privacy policy update needed) and Klecx's own history becomes a second copy. |

**If nothing is decided:** stays at A until after launch, then B.

---

## 6. Faster support on higher plans

- **Found:** 2026-11-18, review of F5.4.
- **Where:** `server/billing/plans.ts` (`features`), `messages/*.json` (`Plans.*.features`).

**The situation.** The Standard plan used to list "Priority customer support" and the F5.4 draft changed it to "Faster email support" on Standard and Pro. Nothing in the app or the support process treats paid plans differently: every request lands in the same queue with the same "within 3 business days" answer (`Marketing.aboutPage.supportText`).

**Today.** No plan lists a support line (rule 9: copy must be true).

**Options.**

| | Option | Effect |
|---|---|---|
| A | No support line (today) | True; all plans get the same support. |
| B | "Faster email support" on Standard and Pro | Needs a real commitment (e.g. answer within 1 business day) and a way to see the plan on each ticket (`SupportTicket` → owner's plan, sort or flag in the inbox). Then add the line back with the target time. |

**If nothing is decided:** stays at A.


---

## 7. A backup grant for monthly paid plans when Creem's payment message is lost

- **Found:** 2026-11-21, Step 8.4.
- **Where:** `server/billing/grants.ts` (`decideGrant`), `server/billing/handlers.ts` (`subscription.paid`).

**The situation.** The guide suggests a "lazy safety net" that grants a monthly plan's credits even when the `subscription.paid` webhook never arrives. Klecx only learns a new billing period (its start and end dates) from Creem's webhooks, so a backup grant can't tell "the renewal was paid but the message is lost" from "the message is just late". When the late message arrives, it would grant the month a second time (the two grants have different ledger keys).

**Today.** Monthly paid plans get credits **only** from `subscription.paid` (Creem retries a failed delivery 4 more times over about 6 h, and Klecx answers 500 when processing fails so the retry runs again). Yearly plans get months 2–12 from the lazy grant, which is safe because the period dates are already known. If a payment message is ever lost for good, support adds the month's credits by hand (`adjust()` in `server/services/credits.ts`; see `ADMIN_CONSOLE.md`).

**Options.**

| | Option | Effect |
|---|---|---|
| A | Webhook only (today) | No double grants. A lost message needs a manual fix. |
| B | Backup after a delay | If the subscription is active and no grant came within e.g. 24 h of the expected renewal (`currentPeriodEnd`), grant with a key per subscription + period, and make `subscription.paid` skip its grant when that period was already granted (refunds then have to find the grant by period instead of by transaction). More code and more cases to test. |
| C | Ask Creem | Fetch the subscription from Creem's API when a renewal is overdue and grant only if it shows a new paid period. Needs a provider call on that path. |

**If nothing is decided:** stays at A.

---

## 8. Top-up credit packs (future feature)

- **Found:** 2026-11-21, Step 8.4 (the guide marks top-ups "optional, post-launch").
- **Where:** `CreditAccount.topupBalance` and `grantTopup()` exist (`server/services/credits.ts`); nothing sells or grants top-ups.

**The situation.** A one-time Creem product (e.g. 500 credits) that someone on a paid plan buys when the monthly allowance runs out. Top-up credits would be spent after the plan allowance and, to keep the schema simple, stay available while the account is active (per-pack expiry would need a table of packs).

**Today.** Not built. Rule 9: no page, FAQ, help article or Terms section mentions top-ups.

**To build it:** a Creem one-time product per pack (and its `CREEM_PRODUCT_*` id), `checkout.completed` for that product → `grantTopup()`, a buy button where credits run low, the refund rule for packs, how long unused packs stay valid (ask a lawyer), and the copy in `en`, `es`, `fr`.

**If nothing is decided:** stays unbuilt and unmentioned.

---

## 9. Self-service downgrades and yearly → monthly

- **Found:** 2026-11-21, Step 8.5.
- **Where:** `lib/billing/plan-changes.ts` (`planChangeKind`), `server/services/billing.ts` (`changePlan`), the billing page.

**The situation.** Creem's plan change (`POST /v1/subscriptions/{id}/upgrade`) always takes effect **at once** (docs.creem.io, read 2026-11-21). With `proration-charge-immediately` a downgrade **refunds the unused time** to the card, although the credits of the bigger plan may already be spent; with `proration-none` the person loses the rest of the bigger plan's period without any refund. Creem has no "change at the next renewal" option.

**Today.** Only upgrades (a higher plan, or monthly → yearly) can be made in Klecx. For a smaller plan or monthly billing, the billing page says: cancel, then subscribe to the new plan when the period ends. Support can change a plan by hand in Creem's dashboard (`ADMIN_CONSOLE.md` §12).

**Options.**

| | Option | Effect |
|---|---|---|
| A | Upgrades only (today) | Simple and safe; a downgrade takes two steps for the person. |
| B | Scheduled downgrade | Klecx stores the wanted plan and, right after the renewal's `subscription.paid`, calls the change with `proration-none`. The first renewal is still charged at the old price unless the change happens before it, so the timing needs care (a job shortly before `currentPeriodEnd`). |
| C | Immediate downgrade with `proration-none` | One click, no refund, the bigger plan's remaining time is lost; the balance is capped at the smaller allowance. Needs clear copy before confirming. |

**If nothing is decided:** stays at A.

---

## 10. Dates in the Usage page's period selector

- **Found:** 2026-11-22, Step 9.3 (owner: "good for now, maybe in a later release").
- **Where:** `components/settings/usage/usage-view.tsx` (the "Period" select), `GET /api/v1/me/usage/summary`.

**The situation.** Settings → Usage has a **Period** selector with "This period" and "Previous period". A credit period runs from one credit refill to the next (Free: the sign-up day each month; paid: each renewal or yearly month; a plan ending starts a new one; upgrades don't). The option labels don't say which dates they cover: the dates only appear under the "Credits" heading after choosing.

**Today.** Labels without dates; the chosen period's dates show as "From … to …" / "Since …" under "Credits".

**Options.**

| | Option | Effect |
|---|---|---|
| A | Keep as is (today) | Simple; the dates are one click away. |
| B | Dates in the labels | "Previous period (14 Oct – 14 Nov)". The summary endpoint (or a small new one) must return both periods' dates up front, since today each call returns only the period asked for. |
| C | More periods | A list of the last few periods with their dates (e.g. the last 12), instead of only two. Needs a periods endpoint built from `getUsagePeriods()`. |

**If nothing is decided:** stays at A.
