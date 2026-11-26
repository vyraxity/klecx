import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect } from "./helpers";

/**
 * Step 10.5: axe (WCAG 2.2 A/AA) on the page as it is now. Fails with one
 * line per violation (rule, impact, how many elements, the first selectors),
 * so a failure says what to fix without opening the report.
 */
export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

export async function expectNoA11yViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const lines = results.violations.map((v) => {
    const targets = v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ");
    const summary = v.nodes[0]?.failureSummary?.split("\n").slice(0, 3).join(" ") ?? "";
    return `${v.id} (${v.impact}, ${v.nodes.length}×): ${targets} — ${summary}`;
  });
  // Soft: one run reports every page, not only the first one with a problem.
  expect.soft(lines, `${label}: accessibility violations`).toEqual([]);
}
