"use client";

import * as React from "react";
import { useFormatter } from "next-intl";

export interface BarListItem {
  key: string;
  label: string;
  value: number;
  /** Extra text after the value (e.g. "12 searches"). */
  note?: string;
}

/**
 * Step 9.3: a labeled bar list (one hue: bars encode amount, not identity).
 * Bars are at most 8px thick with rounded ends; the value sits after the
 * label, so nothing depends on hovering or on colour.
 */
export function BarList({ items, ariaLabel }: { items: BarListItem[]; ariaLabel: string }) {
  const format = useFormatter();
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <ul aria-label={ariaLabel} className="flex flex-col gap-3">
      {items.map((item) => (
        <li key={item.key} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-fg">{item.label}</span>
            <span className="shrink-0 text-xs text-muted tabular-nums">
              <span className="font-semibold text-fg">{format.number(item.value)}</span>
              {item.note ? ` · ${item.note}` : ""}
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-surface-2" aria-hidden>
            <div
              className="h-2 rounded-full bg-accent"
              style={{ width: `${item.value > 0 ? Math.max((item.value / max) * 100, 2) : 0}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
