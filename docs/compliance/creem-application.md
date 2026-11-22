# Creem account review — application checklist

Main guide Step 8.6 (and its "after the interlude" additions). **Apply only when every box is ticked**: the application starts when the payout account is set up in **live mode** (Creem dashboard → **Balance → Payout Account → Set up Payout Account**), reviewers visit the live site, may sign up, try a text answer and make a test purchase with a 100 % discount code. Review takes 1–2 working days (up to 3). Outcomes: approved, changes requested (fix, then **Request re-review**), or rejected (final for that store). Source: docs.creem.io, Account reviews, read 2026-11-22.

Status legend: ✅ done · 🟡 owner to do / check · ⏳ later step

## Before applying

- 🟡 **Payouts to Nigeria**: Creem's docs don't list payout countries. Ask Creem support (bank account vs. USDC, individual vs. CAC-registered business, documents, fees). If unsupported: USDC payouts or a fallback provider (guide §4.2; `BillingProvider` makes it one new adapter).
- 🟡 **Secrets in the public repository's history** rotated (RapidAPI key, old `AUTH_SECRET`, old `NEXT_PUBLIC_ENC_SECRET`): see `CLAUDE.md` open items.
- ⏳ Phases 9 and 10 done; `dev` merged into `main`; Vercel deployment protection **off** for `klecx.com`.

## The site (reviewers check these)

- ⏳ Live on the **own domain** (`klecx.com`, no free subdomain), working sign-up and a **text** answer demo (Free plan).
- ✅ `/terms`, `/privacy`, `/acceptable-use`, `/cookies`, `/pricing`, `/support` exist and are linked from the footer.
- ✅ Pricing visible, prices before tax with the tax note (when `BILLING_ENABLED=true`).
- ✅ Wrapper disclosure in the footer of every marketing page and on the About page; no model or provider name in the product name; no "unlimited"; no fake social proof (Step 8.6 audit).
- ✅ Company identity: "Klecx is a product of Vyraxity · Lagos, Nigeria" in the footer, legal pages, emails and JSON-LD (F0.2).
- ✅ One refund policy, identical in the Terms (section 6), the FAQ and the help article `billing-and-cancellation`.
- ✅ Cancellation inside the app (**Settings → Plan & billing → Cancel plan**, at period end) and the customer portal link (payment methods & invoices).
- ✅ Consent to immediate start before every checkout and upgrade, recorded (`billing_consents`).
- ✅ Privacy policy per the NDPA 2023 (plus GDPR rights for EU/UK), international transfers listed (F5.5); provider data-use evidence in `docs/compliance/ai-provider-data-use.md` (🟡 owner: add the terms URL and screenshot marked TODO there).
- ✅ Cookie notice (F5.6), truthful features / FAQ / status page (F5.4), complete es/fr legal text (F5.5).
- ✅ Web search on for all plans, run only when the model needs it, with a per-day cap (in the abuse document).

## Support and abuse

- 🟡 **Support email**: the same address in Creem's **Business Details**, on `/support` (`SUPPORT_EMAIL`) and on receipts; a mismatch is a common reason for "changes requested". Send a test message and check the inbox receives it.
- 🟡 **Abuse email** (`ABUSE_EMAIL`, shown on `/acceptable-use`): a monitored inbox; reply within 3 business days (stated in the AUP).
- ✅ Admin can suspend an account and freeze its credits (`/api/v1/admin/users/:id/suspend|unsuspend|freeze-credits|unfreeze-credits`, admins only, audited). Until the admin console exists, call them with an admin session (`ADMIN_CONSOLE.md` §14).
- ✅ "How we prevent abuse" document: `docs/compliance/abuse-prevention.md`.

## Payments (test mode, before applying)

- ✅ Checkout, webhooks (signed, recorded once), credits, cancel / resume, upgrade, refunds and disputes built and tested (Steps 8.2–8.5).
- 🟡 **Evidence**: one full test-mode purchase on the deployed preview (`dev.klecx.com`, `BILLING_ENABLED=true` on Preview only), with screenshots or a screen recording of: pricing → consent → Creem checkout → "Activating your plan…" → plan active → cancel → keep my plan; and the matching rows in `billing_events` (status PROCESSED).
- ✅ Image generation off (text-only launch): no Moderation API or Customer Credits needed yet (deferred, see `CLAUDE.md` "Text-only launch").

## The application form (what Creem asks)

Prepare these answers in advance:

1. **Name**: your full name and/or business name (Vyraxity; state honestly whether the CAC registration is done or planned).
2. **Store / product name**: Klecx.
3. **Website**: https://klecx.com
4. **Business description and how you operate**: who you are, Lagos-based, new product, no prior payment processing history; text-first AI workspace built on third-party models; low-risk launch plan (Free plan first, paid plans after approval, refund policy, abuse controls). Paste or summarise `docs/compliance/abuse-prevention.md`.
5. **What you sell**: monthly and yearly subscriptions (Lite, Standard, Pro) to a SaaS workspace; each gives a monthly credit allowance for AI text answers, document reviews and voice input; no physical goods, no services, no image or video generation.
6. **Country of tax residence**: Nigeria.

## After approval (Phase 10, Step 10.6)

- ⏳ Live products recreated in live mode with the same prices as `PLANS`; live API key, product ids and webhook secret in Vercel **Production**; webhook `https://klecx.com/api/webhooks/creem` registered in the live dashboard; default cancellation mode "end of billing period"; product bundles' self-service upgrades off.
- ⏳ One real purchase and refund, end to end.
- ⏳ `BILLING_ENABLED=true` in Production; re-read the billing copy in the running app (`CLAUDE.md` open items).
