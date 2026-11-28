import * as React from "react";
import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { publicPageMetadata } from "@/lib/seo/metadata";
import { getArticles, toMeta } from "@/lib/help/articles";
import { HelpCenterView } from "@/components/help/help-center-view";
import { helpCategoryParam, helpQueryParam } from "@/lib/help/shared";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Help");
  return publicPageMetadata({
    path: "/help",
    title: t("metaTitle"),
    description: t("metaDescription"),
  });
}

type HelpPageProps = {
  searchParams: Promise<{ q?: string | string[]; category?: string | string[] }>;
};

export default async function HelpPage({ searchParams }: HelpPageProps) {
  const locale = await getLocale();
  const articles = getArticles(locale);
  const metaArticles = articles.map(toMeta);

  // `/help?q=…&category=…` (the not-found page's search form, the site's
  // SearchAction in json-ld.tsx, a shared link) opens already filtered.
  const { q, category } = await searchParams;
  const initialQuery = helpQueryParam(q);
  const initialCategory = helpCategoryParam(category);

  return (
    <HelpCenterView
      // A new link to /help with other filters starts from them.
      key={`${initialCategory ?? ""}|${initialQuery}`}
      articles={metaArticles}
      initialQuery={initialQuery}
      initialCategory={initialCategory}
    />
  );
}
