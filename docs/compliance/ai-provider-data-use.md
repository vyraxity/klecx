# AI provider data use: evidence record

This file backs the "no training on your data" sentence in the FAQ (`Marketing.faq.items.privacy.a`) and the About page (`Marketing.aboutPage.privateText`). Implementation guide interlude, Appendix C #3.

Record only what has been checked. Don't add claims here (encryption, certifications, contracts) until there is evidence for them.

## What we say publicly

> Prompts are sent to our AI model provider only to generate your answers, under terms that don't allow them to train on your data.

## Evidence

| Item | Value |
|---|---|
| Confirmed by | Owner (Vyraxity) |
| Date confirmed | 2026-11-08 |
| What was confirmed | The AI provider does not use data sent by third-party apps through its API to train its models. |
| Source (provider terms page) | https://aistudio.google.com/docs/terms (given by the owner on 2026-11-22). _Optional: save a dated PDF or screenshot of the data-use section in this folder, in case the page changes._ |
| Account / tier those terms cover | Vyraxity's Google AI (Gemini API) account, **Tier 1** (a paid, billing-enabled tier), the one production uses (owner, 2026-11-22). |

## Conditions

- Production must always run on the account/tier the terms above cover. A free or trial tier can have different data-use terms.
- Re-check the terms **once a year** (next: 2027-11) and **whenever the AI provider changes**. Update this file and, if the terms change, the FAQ and About copy in `en`, `es` and `fr`.

## Not confirmed (don't claim)

- Database **encryption at rest**: not confirmed with the Postgres host (Appendix C #4). The FAQ and About page don't claim it.
