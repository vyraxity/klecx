"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Step 9.3: a meter. The fill carries severity (accent → warning → danger as
 * it runs out); the track is a lighter surface step.
 */
export function Meter({
  value,
  max,
  label,
  invert = false,
}: {
  value: number;
  max: number;
  label: string;
  /** true: a full meter is good (credits left); false: full is bad (cap used). */
  invert?: boolean;
}) {
  const ratio = max > 0 ? Math.min(Math.max(value / max, 0), 1) : 0;
  const danger = invert ? ratio <= 0.1 : ratio >= 0.9;
  const warning = invert ? ratio <= 0.2 : ratio >= 0.75;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className="h-2 w-full rounded-full bg-surface-2"
    >
      <div
        className={cn(
          "h-2 rounded-full transition-[width]",
          danger ? "bg-danger" : warning ? "bg-warning" : "bg-accent"
        )}
        style={{ width: `${ratio * 100}%` }}
      />
    </div>
  );
}
