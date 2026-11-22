import { Suspense } from "react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import AuthCard from "@/components/auth/AuthCard";
import AuthWrapper from "@/components/auth/AuthWrapper";
import LoginForm from "@/components/auth/LoginForm";
import { parseSubscribeIntent } from "@/lib/billing/intent";
import { getSiteConfig } from "@/server/config/site";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Metadata.auth");
  return {
    title: t("loginTitle"),
    description: t("loginDescription"),
    robots: {
      index: false,
      follow: false,
    },
  };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const LoginPage = async ({ searchParams }: { searchParams: SearchParams }) => {
  const t = await getTranslations("Auth");
  const params = await searchParams;
  // Step 8.5: keep a plan chosen on the pricing page for the register link and OAuth.
  const intent = getSiteConfig().billingEnabled
    ? parseSubscribeIntent(one(params.plan), one(params.interval))
    : null;

  return (
    <AuthWrapper>
      <AuthCard
        page={t("loginTitle")}
        headerText={t("loginSubtitle")}
        backText={t("noAccount")}
        backLink="register"
        intent={intent}
      >
        <Suspense fallback={<div className="h-40" />}>
          <LoginForm />
        </Suspense>
      </AuthCard>
    </AuthWrapper>
  );
};

export default LoginPage;
