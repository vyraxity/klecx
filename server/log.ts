import "server-only";
import pino from "pino";

/**
 * Step 10.2 — structured logs (JSON, one line per event), read in the hosting
 * provider's log viewer (Vercel → Logs). `route()` adds `requestId` to every
 * line it writes, so an error in Sentry can be found in the logs and back.
 *
 * Rule 11: never log secrets, prompts, responses or file contents. Keys that
 * usually carry them are redacted wherever they appear (top level or one level
 * down); email addresses are masked ("a***@example.com"). Errors are reduced
 * to their name, code and a shortened message (`errInfo`), never the object
 * (provider and database errors can quote the request).
 */

const REDACTED_KEYS = [
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "currentPassword",
  "newPassword",
  "token",
  "secret",
  "apiKey",
  "prompt",
  "content",
  "text",
  "body",
  "instruction",
  "email",
];

// pino accessor syntax: `key` / `*.key`, or `["set-cookie"]` / `*["set-cookie"]`.
const paths = REDACTED_KEYS.flatMap((k) =>
  /^\w+$/.test(k) ? [k, `*.${k}`] : [`["${k}"]`, `*["${k}"]`]
);

/** "ada@example.com" → "a***@example.com". */
export function maskEmailForLog(value: unknown): string {
  if (typeof value !== "string" || !value.includes("@")) return "[redacted]";
  const [local, domain] = value.split("@");
  return `${(local ?? "").slice(0, 1)}***@${domain ?? ""}`;
}

/** An error, safe to log: name, code and the first 300 characters of the message. */
export function errInfo(err: unknown): { name: string; code?: string; message?: string } {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      name: err.name,
      ...(typeof code === "string" || typeof code === "number" ? { code: String(code) } : {}),
      message: err.message.slice(0, 300),
    };
  }
  // Already reduced (`err: errInfo(e)` then pino's `err` serializer): keep it.
  if (err && typeof err === "object" && typeof (err as { name?: unknown }).name === "string") {
    const o = err as { name: string; code?: unknown; message?: unknown };
    return {
      name: o.name.slice(0, 100),
      ...(typeof o.code === "string" ? { code: o.code } : {}),
      ...(typeof o.message === "string" ? { message: o.message.slice(0, 300) } : {}),
    };
  }
  return { name: typeof err === "string" ? "string_error" : "unknown_error" };
}

function resolveLevel(): pino.LevelWithSilent {
  const raw = process.env.LOG_LEVEL;
  if (raw && ["fatal", "error", "warn", "info", "debug", "trace", "silent"].includes(raw)) {
    return raw as pino.LevelWithSilent;
  }
  return process.env.NODE_ENV === "test" ? "silent" : "info";
}

/** A logger writing to `destination` (stdout by default). Tests pass their own stream. */
export function createLogger(
  destination?: pino.DestinationStream,
  level: pino.LevelWithSilent = resolveLevel()
) {
  return pino(
    {
      level,
      base: {
        env: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
        ...(process.env.VERCEL_GIT_COMMIT_SHA ? { release: process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 12) } : {}),
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      serializers: { err: errInfo },
      redact: {
        paths,
        censor: (value, path) => (path[path.length - 1] === "email" ? maskEmailForLog(value) : "[redacted]"),
      },
    },
    destination ?? pino.destination(1)
  );
}

export const log = createLogger();

export type Logger = typeof log;
