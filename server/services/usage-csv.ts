import "server-only";
import type { CreditHistoryEntry } from "@/lib/usage/types";

type T = (key: string, values?: Record<string, unknown>) => string;

/** A CSV cell: quoted, and text that a spreadsheet would run as a formula is defused. */
export function csvCell(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Step 9.3: the credit history as CSV, with the same labels as the page. */
export function creditHistoryCsv(entries: CreditHistoryEntry[], t: T): string {
  const header = ["date", "description", "workspace", "by", "model", "credits", "balance"].map((k) =>
    csvCell(t(`Usage.history.csv.${k}`))
  );
  const lines = entries.map((e) => {
    const description =
      e.type === "usage" ? t(`Usage.kinds.${e.label}`) : t(`Usage.history.reasons.${e.label}`);
    const model = e.modelKey ? safeModelName(t, e.modelKey) : "";
    return [
      csvCell(e.at),
      csvCell(description),
      csvCell(e.workspaceTitle ?? ""),
      csvCell(e.byOther ? (e.actorName ?? t("Usage.history.someone")) : ""),
      csvCell(model),
      csvCell(e.amount),
      csvCell(e.balanceAfter),
    ].join(",");
  });
  // BOM so spreadsheet apps read accents correctly.
  return "﻿" + [header.join(","), ...lines].join("\r\n") + "\r\n";
}

function safeModelName(t: T, key: string): string {
  try {
    const name = t(`Models.${key}.name`);
    return name.startsWith("Models.") ? key : name;
  } catch {
    return key;
  }
}
