"use client";

import * as React from "react";
import { useFormatter, useTranslations } from "next-intl";
import type { UsageTimeseriesPoint } from "@/lib/usage/types";

const HEIGHT = 180;
/** SVG text-anchor keywords (not user-visible text): first, middle, last tick. */
const TEXT_ANCHOR = ["start", "middle", "end"] as const;
const PAD = { top: 12, right: 12, bottom: 24, left: 40 };

/** Clean axis maximum and 3 ticks (0, half, max). */
function niceMax(value: number): number {
  if (value <= 0) return 10;
  const exp = 10 ** Math.floor(Math.log10(value));
  const n = value / exp;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * exp;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = React.useRef<T | null>(null);
  const [width, setWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/**
 * Step 9.3: daily credits as one area series (accent line, 10% wash). A
 * crosshair snaps to the nearest day on hover; arrow keys move it when the
 * chart has focus. Every value is also in the table view below the chart.
 */
export function UsageAreaChart({ points }: { points: UsageTimeseriesPoint[] }) {
  const t = useTranslations("Usage.chart");
  const format = useFormatter();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = React.useState<number | null>(null);

  const innerW = Math.max(width - PAD.left - PAD.right, 1);
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const max = niceMax(Math.max(...points.map((p) => p.credits), 0));
  const x = (i: number) => PAD.left + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.credits).toFixed(1)}`).join(" ");
  const area = points.length
    ? `${line} L${x(points.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`
    : "";
  const dayLabel = (day: string) =>
    format.dateTime(new Date(`${day}T00:00:00Z`), { month: "short", day: "numeric", timeZone: "UTC" });

  const pick = (clientX: number, rect: DOMRect) => {
    const rel = clientX - rect.left - PAD.left;
    const i = Math.round((rel / innerW) * (points.length - 1));
    setActive(Math.min(Math.max(i, 0), points.length - 1));
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!points.length) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      setActive((cur) => {
        const start = cur ?? points.length - 1;
        return Math.min(Math.max(start + (e.key === "ArrowRight" ? 1 : -1), 0), points.length - 1);
      });
    } else if (e.key === "Escape") setActive(null);
  };

  const activePoint = active !== null ? points[active] : null;
  const ticks = [0, max / 2, max];
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(innerW / 70))));
  const total = points.reduce((a, p) => a + p.credits, 0);

  return (
    <div ref={ref} className="relative w-full">
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={t("label", { total, days: points.length })}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
        onPointerLeave={() => setActive(null)}
        className="block touch-pan-y outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-lg"
      >
        {width > 0 && (
          <>
            {ticks.map((v) => (
              <g key={v} className="text-border">
                <line x1={PAD.left} x2={PAD.left + innerW} y1={y(v)} y2={y(v)} stroke="currentColor" strokeWidth={1} />
                <text x={PAD.left - 6} y={y(v)} dy="0.32em" textAnchor="end" className="fill-muted text-[10px] tabular-nums">
                  {format.number(v, { notation: v >= 10_000 ? "compact" : "standard" })}
                </text>
              </g>
            ))}
            {points.map((p, i) => {
              const last = points.length - 1;
              // Regular ticks, plus the last day; a tick too close to the last is dropped.
              const show = i === last || (i % labelEvery === 0 && last - i >= labelEvery * 0.75);
              if (!show) return null;
              const anchor = TEXT_ANCHOR[points.length > 1 && i === 0 ? 0 : points.length > 1 && i === last ? 2 : 1];
              return (
                <text key={p.day} x={x(i)} y={HEIGHT - 6} textAnchor={anchor} className="fill-muted text-[10px]">
                  {dayLabel(p.day)}
                </text>
              );
            })}
            <g className="text-accent">
              <path d={area} fill="currentColor" fillOpacity={0.1} />
              <path d={line} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {activePoint && active !== null && (
                <>
                  <line
                    x1={x(active)}
                    x2={x(active)}
                    y1={PAD.top}
                    y2={PAD.top + innerH}
                    className="text-border-strong"
                    stroke="currentColor"
                    strokeWidth={1}
                  />
                  <circle cx={x(active)} cy={y(activePoint.credits)} r={4} fill="currentColor" stroke="var(--surface)" strokeWidth={2} />
                </>
              )}
            </g>
          </>
        )}
      </svg>
      {activePoint && active !== null && (
        <div
          role="status"
          className="pointer-events-none absolute top-0 z-10 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs shadow-md"
          style={{
            left: Math.min(Math.max(x(active) - 60, 0), Math.max(width - 130, 0)),
          }}
        >
          <p className="font-semibold text-fg tabular-nums">{t("credits", { count: activePoint.credits })}</p>
          <p className="text-muted">
            {dayLabel(activePoint.day)} · {t("calls", { count: activePoint.generations })}
          </p>
        </div>
      )}
    </div>
  );
}
