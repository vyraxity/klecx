/**
 * Step 10.5: reduced motion for scripted scrolling. CSS can't slow down
 * `scrollIntoView({ behavior: "smooth" })`, so code asks here: "auto" when
 * the device asks for less motion or the account's "Reduce motion" is on
 * (`data-reduce-motion="true"` on <html>, Step 9.2).
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  if (document.documentElement.dataset.reduceMotion === "true") return true;
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}
