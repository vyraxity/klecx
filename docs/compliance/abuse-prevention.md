# How Klecx prevents abuse

One page, written for the Creem account review (main guide Step 8.6). Paste it into the application's business description, or attach it. Keep it true: update it when a limit below changes (the numbers come from `server/billing/plans.ts` and `server/http/rate-limit.ts`).

---

**Klecx** (a product of Vyraxity, Lagos, Nigeria) is a workspace for working with AI-written text: projects, versioned answers, comments and questions on passages, documents and collaboration. It is a new product with no prior payment-processing history. It is built on third-party AI models and says so on every marketing page (footer: "Klecx is an independent workspace built on third-party AI models"); the product name contains no model or provider name.

**Text only at launch.** Klecx launches without image or video generation. Image generation is switched off in the code and on the pricing page; it will only be turned on after we have integrated Creem's Customer Credits and Moderation API and confirmed with Creem.

## Who can use it

- Sign-up needs a verified email address; unverified accounts can't sign in and get no monthly credits.
- Throwaway-inbox email domains are refused at sign-up.
- Sign-ups are limited to 5 per hour per IP address; sign-in attempts to 5 per minute per IP and email.

## How much anyone can use

- Every AI action costs **credits**, shown before sending. There is no "unlimited" tier.
- Each plan has a **daily credit cap** (Free 30 credits a day; paid plans 20–25 % of the monthly allowance a day) and a limit on **AI answers running at the same time** (1 to 5 by plan), counted on the workspace owner's account, so collaborators can't multiply them.
- **Web search** runs only when the model decides it needs it, costs extra credits, and is capped per person per day (10 to 200 searches by plan).
- Voice input has its own daily limit (2 to 40 minutes by plan).
- Read-aloud with natural voices (paid plans only) costs credits from the listener's own balance and has a daily limit (30 to 120 minutes of audio by plan); it is limited to 20 read-aloud requests per hour and 20,000 characters per request. The free alternative uses the device's own voices.
- Every API endpoint is rate-limited per account (e.g. 20 answer starts per minute, 120 requests per minute overall).

## Content

- Our Acceptable Use Policy (`/acceptable-use`) forbids sexually explicit content and romantic or sexual role-play with the AI (Klecx is a work tool, not a companion chatbot), harassment and hate, malware and cyberattacks, fraud and impersonation, spam, scraping or reselling the service, prompt injection, and getting around credit, plan or rate limits.
- Requests go through the AI provider's own safety filters; answers that are blocked are refused and not charged.
- Public share links are read-only, can be removed by their owner at any time, and are rate-limited.

## Reports and enforcement

- Abuse reports: the abuse email address on `/acceptable-use`. We reply within **3 business days**. Support requests (`/support`) also get an answer within 3 business days.
- An administrator can **suspend** an account (sign-in refused, every session revoked at once) and **freeze its credits** (nothing can be spent), with an audit record of who did it and why. Nothing is deleted, so evidence is kept.

## Payments, refunds and disputes

- Creem is the merchant of record. Prices are shown before tax; taxes are added at checkout.
- Before paying, buyers confirm that the service starts at once (EU/UK withdrawal right). We keep a record of that consent.
- Cancelling is self-service in **Settings → Plan & billing** (the plan stays until the end of the paid period).
- One refund policy, the same in the Terms, FAQ and help centre: a full refund of the first payment within 14 days if less than 20 % of its credits were used (once per customer); a renewal within 7 days if no credits were used; duplicate charges and billing errors always. Refund requests are checked against the credit history automatically, so decisions are consistent.
- A refund removes the unused credits of that payment, and a full refund ends the paid plan at once.
- A **dispute** freezes the account's credits immediately and alerts us; we answer with the credit and activity history as evidence.
- Every payment event from Creem is verified (signed webhooks), recorded once, and kept as an audit trail.

## Privacy

Prompts are sent to the AI provider only to produce answers, under terms that don't allow training on them. Logs never contain prompts, answers, file contents or secrets. Privacy policy: `/privacy` (Nigeria Data Protection Act 2023, plus GDPR rights for EU/UK visitors).
