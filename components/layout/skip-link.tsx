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
      className="sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-[100] focus:rounded-lg focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-fg focus:shadow-lg focus:outline-2 focus:outline-ring"
    >
      {t("skipToContent")}
    </a>
  );
}
