import { NextResponse } from "next/server";
import { route } from "@/server/http/route";
import { getMySubscription } from "@/server/services/billing";

/** Step 8.2: the caller's subscription; polled after checkout until the webhook activates it. */
export const GET = route({
  disableCookieCache: true,
  handler: async ({ actor }) =>
    NextResponse.json(
      { data: await getMySubscription(actor.userId) },
      { headers: { "Cache-Control": "private, no-store" } }
    ),
});
