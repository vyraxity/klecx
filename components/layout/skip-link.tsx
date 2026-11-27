import { useTranslations } from "next-intl";

export const MAIN_CONTENT_ID = "main-content";

/**
 * Step 10.5: the first Tab stop on every page jumps past the navigation to
 * the main content. Hidden until focused.
 */
export function SkipLink() {
  const t = useTranslations("Common");
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      // Full size but moved above the viewport until focused (a 1 px `sr-only`
      // link counts as a too-small touch target).
      className="fixed start-3 top-3 z-[100] -translate-y-[200%] rounded-lg bg-surface px-4 py-2 text-sm font-semibold text-fg shadow-lg focus:translate-y-0 focus:outline-2 focus:outline-ring"
    >
      {t("skipToContent")}
    </a>
  );
}
