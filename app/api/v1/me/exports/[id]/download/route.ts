import { NextResponse } from "next/server";
import { route } from "@/server/http/route";
import { getDataExportDownloadUrl } from "@/server/services/data-export";

/** Step 9.5: download an export (its owner only, signed in, while it's valid): a short-lived signed link. */
export const GET = route({
  handler: async ({ actor, params }) => {
    const url = await getDataExportDownloadUrl(actor, params.id as string);
    return NextResponse.redirect(url, { status: 302, headers: { "cache-control": "no-store" } });
  },
});
