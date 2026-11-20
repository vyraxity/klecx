import { handleBillingWebhook } from "@/server/services/billing-webhook";

/**
 * Step 8.3: Creem webhooks. Public (no session; `proxy.ts` leaves
 * `/api/webhooks/*` alone): the HMAC signature on the raw body is the
 * authentication, checked before anything is parsed or stored.
 */
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
  const raw = await req.text(); // the raw body: never req.json() before verifying
  const { status, body } = await handleBillingWebhook(raw, req.headers.get("creem-signature"), requestId);
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
