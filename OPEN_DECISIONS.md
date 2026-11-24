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

---

## 11. Read-aloud parts that follow the text's structure (future feature)

- **Found:** 2026-11-23, Step 9.4 (owner: for a later release).
- **Where:** `chunkSpeech()` in `lib/speech/prepare.ts`.

**The situation.** Natural-voice audio is made one part at a time (at most 1,500 characters). If someone stops before the next part is made, the parts made so far are paid for and cached. The owner wants every part to end at a natural break, so a part never stops in the middle of a thought.

**Today.** A part already ends at the **end of a sentence**, never inside a word or a sentence: sentences are found with the browser/Node sentence segmenter (`Intl.Segmenter`) and added to a part while they fit; paragraphs stay together while they fit. Only a **single sentence longer than 1,500 characters** is cut, between two words. What it doesn't do: prefer the end of a **paragraph** or a **section** (a heading starts a new part only by chance), so a part can end after the first sentence of a paragraph.

**To build it:** score the possible break points inside the 1,500-character window and take the best one near the end: the end of a section (before a heading) first, then the end of a paragraph or list, then the end of a sentence; never make a part much shorter than, say, 600 characters just to reach a better break. Cut an over-long sentence at a clause (`;`, `:`, `,`, a dash) before falling back to a word. Note: changing how parts are cut changes their text, so audio cached under the old cutting is no longer reused (made again once, then cached).

**If nothing is decided:** stays as today.

---

## 12. Read-aloud remembers where you stopped (future feature)

- **Found:** 2026-11-23, Step 9.4 (owner: for a later release).
- **Where:** the player (`lib/speech/player-store.ts`), `POST /api/v1/speech` (prepare).

**Today.** Read aloud always starts at part 1. Parts already made with the same voice come from the cache (free, quick), and "Next part" skips ahead.

**To build it:** save the part reached per person and text (e.g. a `ReadAloudProgress` row: user, text key — the same key the player uses, which changes when the text is edited — part index, updated at), written when reading pauses, stops or moves to a new part, so it follows the person across devices. Read aloud then offers "Resume from part 3" or "Start over". Forget it when the text changes or after the last part. Saving the position inside a part (seconds) is possible for natural voices only (the browser voice can't seek), so the part is the unit.

**If nothing is decided:** not built.

---

## 13. Follow the text while reading aloud (future feature)

- **Found:** 2026-11-23, Step 9.4 (owner: for a later release; goes with the floating player built in 9.4).
- **Where:** the floating player (`components/speech/read-aloud-dock.tsx`), `UserPreference`.

**The situation.** While a text is read aloud, highlight the part (or sentence) being read and scroll the page so it stays in view. The floating player gets a switch "Highlight while reading"; the choice is saved on the account (a new `UserPreference` field, like the theme) so it applies on every device and to every later reading.

**Today.** Not built. The player has "Go to the text being read", which scrolls back to the text's Read aloud button.

**What makes it work:** the spoken text is a cleaned-up copy of the Markdown (`lib/speech/prepare.ts` drops code, links' URLs, citation markers…), so each part must keep a map back to its place in the rendered text (offsets in the source, the way annotations anchor passages). Then: with the **browser voice**, the browser reports each word as it's spoken (`boundary` events), so word or sentence highlighting is exact; with **natural voices**, only the part's audio and its length are known, so highlight the whole part, or estimate the sentence from the time played. Respect reduced motion (no smooth scrolling) and stop following when the person scrolls away by hand.

**If nothing is decided:** not built.

---

## 14. Reading aloud texts longer than 20,000 characters (future feature)

- **Found:** 2026-11-23, Step 9.4 (owner: for a later release).
- **Where:** `MAX_SPEECH_CHARS` and `prepareSpeech()` (`lib/speech/prepare.ts`), `prepareReadAloud()` (`server/services/speech.ts`), the player.

**Today.** One reading covers at most 20,000 characters (about 13 parts, 20–25 minutes); a longer answer or document reads only its start and the player says "This text is long: only the first part is read aloud."

**The owner's idea.** Long texts can be read in full. Before starting a text over the limit, a dialog says it's long, gives an **estimate of the credits** it will use (from its length: `estimateAudioSeconds()` and `speechCreditsFor()`, "about N credits") and offers **Read all**, **Read the first part** (as today) and **Cancel**.

**Points to settle when building it:**
- Raise the server's limit for a confirmed request (e.g. `confirmLong: true` in the prepare call) to a hard ceiling that still protects the server (say 200,000 characters), and return the estimate in the prepare response so the dialog shows the server's number.
- The **daily natural-voice limit** (30 / 60 / 120 min) still applies: a long text can run past it, and the player then carries on with the browser voice. The dialog should say how much natural-voice time is left today.
- Credits are still charged per part as it's made, so stopping early costs only what was made (the estimate is the most it can cost).
- With the **browser voice** nothing is charged, so no credit estimate: either read it all without asking, or only mention the length.
- Pairs well with §12 (resume where you stopped) for long documents.

**If nothing is decided:** stays at 20,000 characters.

---

## 15. Antivirus scanning of uploaded files

- **Found:** 2026-11-23, Step 10.1 (guide: "consider antivirus scanning before text extraction").
- **Where:** upload completion (`completeAttachment()` in `server/services/attachment.ts`), text extraction (`server/files/extract.ts`), support screenshots.

**Today.** No scanning. Uploads are checked by content sniffing against an allow-list, size limits per plan and extraction timeouts; files are only read as text, never run, and downloads from our origin are sent as `attachment` with `nosniff` and a sandboxing CSP. Other members can download a file someone uploaded to a shared workspace, so a malicious DOCX/PDF could reach a collaborator's computer.

**Options.** (a) Nothing until there's a real need (recommended for launch: low risk, no extra cost). (b) A Cloudinary add-on that scans uploads (paid per file; check the plan). (c) A ClamAV service (needs hosting outside Vercel).

**If nothing is decided:** (a); `docs/security-review.md` keeps it as gap G6.

---

## 16. Two-factor sign-in for Google/GitHub sign-ins

- **Found:** 2026-11-23, two-factor sign-in (after Step 10.1).
- **Where:** Better Auth's `twoFactor` plugin challenges only password sign-ins (`/sign-in/email`); `server/auth/auth.ts`.

**Today.** Two-factor protects signing in with email and password, and needs a password on the account. Signing in with Google or GitHub skips Klecx's code and relies on that provider's own two-step verification (the help article and Settings say so). Someone with both a password and Google connected could therefore be reached through Google without Klecx's code.

**Options.** (a) Keep it (the usual behaviour; recommended for launch). (b) Also ask for the Klecx code after a Google/GitHub sign-in when two-factor is on: a custom hook on the OAuth callback that replaces the new session with a challenge, like the plugin does for passwords (more code, and the callback is a redirect, so it needs its own flow).

**If nothing is decided:** (a).

---

## 17. The web-search surcharge (decided)

- **Decided by the owner on 2026-11-24:** the surcharge goes from **3 to 5 credits** per search ($0.010), applied in the "search date and AI prices" fix PR (CLAUDE.md). Standard Reasoning keeps today's credit prices.
- **Why 5 and not 7–8:** the provider charges $0.014 per search query after 5,000 free a month (shared by all Gemini 3+ models), plus the search step's own tokens (about $0.001–0.003). At 5 credits each search earns ~$0.008 while inside the free 5,000 and loses ~$0.006 beyond it, so the month stays profitable up to roughly 11,000 searches (one query each; more queries per search lower that).
- **Revisit when** the metrics (`GET /api/v1/admin/metrics` → `searches`) show the month regularly passing ~10,000 searches, or several queries per search: then about 8 credits covers the full cost.

---

## 18. The provider's daily cap on searches (1,500 a day for all of Klecx)

- **Found:** 2026-11-24 (owner, from the pricing page).
- **Where:** every Klecx web search is one grounded request to the economy model (`runWebSearch()` in `server/ai/tools/web-search.ts`, called by `server/services/web-search.ts`).

**Today.** The provider allows 1,500 grounded requests a day for the whole account. Past that, searches fail until the next day; Klecx then answers without searching and doesn't charge (the search "didn't run"), but everyone loses search for the rest of the day. With the plan caps (10 / 50 / 100 / 200 a day per person), ~8 Pro users at their cap, or ~150 Free users, could use it all.

**Options (can be combined).** (a) **Protect it:** count Klecx's grounded requests per UTC day; near the cap, stop searches for Free first and keep the rest for paid plans; reuse a recent result for the same query for a short time (e.g. 15 minutes) so repeated questions don't spend new requests; alert at 80 %. (b) **A second search source** behind one interface (`runWebSearch` → a `SearchProvider`): a web-search API (e.g. Brave Search, Tavily, Exa or similar — compare price per 1,000, limits, terms for AI use and data retention) whose results Klecx passes to the model itself; the fallback when Google's cap is reached, or the main source if cheaper. Adds a processor to the Privacy Policy. (c) **Ask Google** whether the grounding cap rises with the paid usage tier or on request (or what Vertex AI's grounding quota is). Never split traffic across several projects or keys to get around a limit.

**Owner, 2026-11-24:** nothing is built for this now; to be decided **after launch**, from the first users' feedback and the search metrics. Until then, past 1,500 grounded requests in a day, searches simply stop for everyone until midnight UTC (answers still work and nobody is charged for a search that didn't run). A near-cap alert (count grounded requests per UTC day, warn at ~80 %) is cheap and can be added on its own any time.
