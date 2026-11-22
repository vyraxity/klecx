import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { HIGHLIGHT_CSS } from "@/lib/annotations/highlight-styles";
import QueryProvider from "@/components/providers/query-provider";
import { SiteConfigProvider } from "@/components/providers/site-config-provider";
import { cookies } from "next/headers";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { getActor } from "@/server/auth/session";
import { getDisplayPreferences } from "@/server/services/user-preferences";
import { getLocaleSuggestion } from "@/server/i18n/locale-suggestion";
import { LocaleSuggestionBanner } from "@/components/layout/locale-suggestion-banner";
import { THEME_COOKIE, THEME_INIT_SCRIPT, parseTheme, serverThemeAttribute } from "@/lib/theme";
import { Toaster } from "@/components/ui/sonner";
import { OfflineBanner } from "@/components/offline/offline-banner";
import { CookieNotice } from "@/components/legal/cookie-notice";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import { getSiteConfig } from "@/server/config/site";
import { getLocaleDefinition, getAlternateOgLocales } from "@/i18n/locales";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

const siteUrl = getSiteConfig().appUrl;

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const localeDef = getLocaleDefinition(locale);
  const t = await getTranslations("Metadata");
  const site = getSiteConfig();
  const xHandle = site.social.x
    ? new URL(site.social.x).pathname.split("/").filter(Boolean)[0]
    : undefined;

  const defaultTitle = t("root.title");
  const titleTemplate = t("root.titleTemplate");
  const description = t("root.description");
  const applicationName = t("root.applicationName");
  const keywordsString = t("root.keywords");
  const keywords = keywordsString.split(",").map((k) => k.trim());

  return {
    metadataBase: new URL(siteUrl),
    title: {
      default: defaultTitle,
      template: titleTemplate,
    },
    description,
    applicationName,
    authors: [{ name: site.appName }],
    keywords,
    manifest: "/manifest.webmanifest",
    // Icons come from the file conventions: app/favicon.ico, app/icon.tsx and
    // app/apple-icon.tsx, all drawn from lib/brand/mark.ts (F5.10).
    openGraph: {
      type: "website",
      locale: localeDef.ogLocale,
      alternateLocale: getAlternateOgLocales(locale),
      url: siteUrl,
      siteName: site.appName,
      title: defaultTitle,
      description,
      // Images: app/opengraph-image.tsx and app/twitter-image.tsx (localized).
    },
    twitter: {
      card: "summary_large_image",
      title: defaultTitle,
      description,
      ...(xHandle ? { creator: `@${xHandle}` } : {}),
    },
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const messages = await getMessages();
  const siteConfig = getSiteConfig();

  // Step 9.2: theme and reduced motion are on <html> in the first HTML, so the
  // page never flashes the wrong colours. A signed-in person's account choice
  // wins over this device's cookie.
  const cookieTheme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  const actor = await getActor().catch(() => null);
  const display = actor
    ? await getDisplayPreferences(actor.userId).catch(() => null)
    : null;
  const theme = display?.theme ?? cookieTheme;
  const localeSuggestion = await getLocaleSuggestion(locale, actor?.userId ?? null).catch(
    () => null
  );

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable}`}
      data-theme-pref={theme ?? undefined}
      data-theme={theme ? serverThemeAttribute(theme) : undefined}
      data-reduce-motion={display?.reduceMotion ? "true" : undefined}
      data-density={display?.density === "compact" ? "compact" : undefined}
    >
      <head>
        {/* Resolves "system" (and an old next-themes choice) before paint. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <style dangerouslySetInnerHTML={{ __html: HIGHLIGHT_CSS }} />
      </head>
      <body className="bg-bg text-fg font-sans antialiased">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <SiteConfigProvider value={siteConfig}>
            <QueryProvider>
              <ThemeProvider
                initialTheme={theme}
                cookieTheme={cookieTheme}
                saveToAccount={Boolean(actor)}
              >
                <OfflineBanner />
                {localeSuggestion && (
                  <LocaleSuggestionBanner
                    suggestion={localeSuggestion}
                    saveToAccount={Boolean(actor)}
                  />
                )}
                {children}
                <CookieNotice />
                <Toaster position="bottom-right" />
              </ThemeProvider>
            </QueryProvider>
          </SiteConfigProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
