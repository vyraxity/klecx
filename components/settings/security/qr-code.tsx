"use client";

import * as React from "react";
import { encode } from "uqr";

/**
 * A QR code drawn as SVG from its module matrix (no HTML injection, no
 * network). Always dark on light, in both themes, so every scanner reads it.
 */
export function QrCode({ value, label, size = 192 }: { value: string; label: string; size?: number }) {
  const { path, dim } = React.useMemo(() => {
    const qr = encode(value, { ecc: "M", border: 2 });
    let d = "";
    qr.data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) d += `M${x} ${y}h1v1h-1z`;
      })
    );
    return { path: d, dim: qr.size };
  }, [value]);

  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${dim} ${dim}`}
      shapeRendering="crispEdges"
      className="rounded-lg bg-qr-light text-qr-dark"
    >
      <path d={path} fill="currentColor" />
    </svg>
  );
}
