/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { UsageAreaChart } from "@/components/settings/usage/usage-area-chart";
import { BarList } from "@/components/settings/usage/bar-list";
import { Meter } from "@/components/settings/usage/meter";

jest.mock("next-intl", () => jest.requireActual("../test-utils/next-intl").nextIntlMock);

beforeAll(() => {
  // jsdom has no layout: report a fixed width.
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 600 });
});

const points = [
  { day: "2026-11-20", credits: 0, generations: 0 },
  { day: "2026-11-21", credits: 12, generations: 3 },
  { day: "2026-11-22", credits: 30, generations: 5 },
];

describe("Step 9.3 — usage UI", () => {
  it("the daily chart is described and readable with the keyboard", () => {
    render(<UsageAreaChart points={points} />);
    const chart = screen.getByRole("img");
    expect(chart.getAttribute("aria-label")).toContain("42");
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(screen.getByRole("status")).toHaveTextContent("12");
    fireEvent.keyDown(chart, { key: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("bar lists print every value next to its label", () => {
    render(
      <BarList
        ariaLabel="By kind"
        items={[
          { key: "text", label: "Answers", value: 20 },
          { key: "webSearch", label: "Web searches", value: 6, note: "2 searches" },
        ]}
      />
    );
    const list = screen.getByRole("list", { name: "By kind" });
    expect(list).toHaveTextContent("Answers");
    expect(list).toHaveTextContent("20");
    expect(list).toHaveTextContent("2 searches");
  });

  it("meters exposes their value and turn to warning/danger as credits run out", () => {
    const { rerender } = render(<Meter value={80} max={100} label="Credits left" invert />);
    const meter = screen.getByRole("meter", { name: "Credits left" });
    expect(meter).toHaveAttribute("aria-valuenow", "80");
    expect(meter.firstElementChild?.className).toContain("bg-accent");
    rerender(<Meter value={15} max={100} label="Credits left" invert />);
    expect(screen.getByRole("meter").firstElementChild?.className).toContain("bg-warning");
    rerender(<Meter value={5} max={100} label="Credits left" invert />);
    expect(screen.getByRole("meter").firstElementChild?.className).toContain("bg-danger");
  });
});
