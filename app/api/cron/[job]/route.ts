import { route } from "@/server/http/route";
import { authorizeCron } from "@/server/jobs/auth";
import { Errors } from "@/server/http/errors";
import { isJobName, runJob } from "@/server/jobs/registry";

/**
 * Step 10.3: runs one background job. Called by the scheduler with
 * `Authorization: Bearer <CRON_SECRET>` (GitHub Actions today, Vercel Cron
 * later: it sends the same header and uses GET). No session; `proxy.ts`
 * leaves `/api/cron` alone. 200 when the job ran or was skipped (another run
 * holds its lock), 500 when it failed (so the scheduler shows a failed run).
 */
const handler = route({
  auth: "optional",
  handler: async ({ req, params }) => {
    authorizeCron(req.headers.get("authorization"));
    const job = String(params.job ?? "");
    if (!isJobName(job)) throw Errors.notFound("Job");
    const outcome = await runJob(job);
    return Response.json(
      { data: outcome },
      { status: outcome.status === "FAILED" ? 500 : 200, headers: { "cache-control": "no-store" } }
    );
  },
});

export const GET = handler;
export const POST = handler;
