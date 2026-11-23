import { z } from "zod";

/**
 * Step 10.1: zod probes `new Function("")` to speed up parsing. Under our strict
 * Content-Security-Policy (no 'unsafe-eval') the probe fails harmlessly but
 * every page with a form would send a CSP violation report. In the browser we
 * turn that optimisation off; the server keeps it.
 */
if (typeof window !== "undefined") {
  z.config({ jitless: true });
}
