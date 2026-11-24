/**
 * Step 10.2 — Sentry options shared by the server, edge and browser SDKs.
 *
 * Sentry is OFF until `NEXT_PUBLIC_SENTRY_DSN` is set (the DSN is a public
 * value: it only lets someone send events, which the tunnel restricts to our
 * project). No personal data: `sendDefaultPii` is false and `scrubEvent`
 * removes request bodies, cookies, headers, query strings (they can hold
 * tokens) and every user field but the id. Nothing is sampled for tracing
 * unless `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` says so.
 */

/** Same-origin route the browser sends events to (no ad blocker, no CSP host). */
export const SENTRY_TUNNEL_ROUTE = "/sentry-tunnel";

export function sentryDsn(): string | undefined {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  return dsn && dsn.startsWith("https://") ? dsn : undefined;
}

export function sentryEnvironment(): string {
  return process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.VERCEL_ENV || process.env.NODE_ENV || "development";
}

function tracesSampleRate(): number {
  const n = Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0");
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0;
}

/** Drops the query string and fragment of a URL (tokens live there). */
export function stripQuery(url: unknown): unknown {
  if (typeof url !== "string") return url;
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

type MinimalEvent = {
  request?: { url?: string; data?: unknown; cookies?: unknown; headers?: Record<string, string>; query_string?: unknown; env?: unknown };
  user?: { id?: string | number; [k: string]: unknown };
  breadcrumbs?: { category?: string; message?: string; data?: Record<string, unknown> }[];
  extra?: Record<string, unknown>;
};

/** Removes anything that could identify a person or carry their content. */
export function scrubEvent<E extends MinimalEvent>(event: E): E {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.query_string;
    delete event.request.env;
    const ua = event.request.headers?.["user-agent"] ?? event.request.headers?.["User-Agent"];
    event.request.headers = ua ? { "user-agent": ua } : {};
    event.request.url = stripQuery(event.request.url) as string | undefined;
  }
  if (event.user) event.user = event.user.id !== undefined ? { id: event.user.id } : {};
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs
      // Console breadcrumbs repeat log lines; logs already carry what matters.
      .filter((b) => b.category !== "console")
      .map((b) => {
        if (!b.data) return b;
        const data = { ...b.data };
        for (const k of ["url", "from", "to"]) if (k in data) data[k] = stripQuery(data[k]);
        delete data.body;
        return { ...b, data };
      });
  }
  return event;
}

export function sharedSentryOptions() {
  return {
    dsn: sentryDsn(),
    enabled: Boolean(sentryDsn()),
    environment: sentryEnvironment(),
    sendDefaultPii: false,
    tracesSampleRate: tracesSampleRate(),
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
  };
}
