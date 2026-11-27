import type { Pluggable } from "unified";

/**
 * Step 10.5: KaTeX (≈ 280 KB of script plus its stylesheet and fonts) loads
 * only when a text contains a formula. Until it has loaded, formulas show as
 * their TeX source for a moment; then every <Markdown> re-renders with it.
 */
let plugin: Pluggable | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** remark-math's delimiters (`$…$`, `$$…$$`) need a dollar sign. */
export function mayContainMath(text: string): boolean {
  return text.includes("$");
}

export function loadKatex(): Promise<void> {
  loading ??= Promise.all([import("rehype-katex"), import("katex/dist/katex.min.css")])
    .then(([mod]) => {
      plugin = mod.default;
      listeners.forEach((l) => l());
    })
    .catch(() => {
      loading = null; // try again next time a formula appears
    });
  return loading;
}

export function subscribeKatex(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getKatexPlugin(): Pluggable | null {
  return plugin;
}
