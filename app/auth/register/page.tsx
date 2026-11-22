import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import AuthCard from "@/components/auth/AuthCard";
import AuthWrapper from "@/components/auth/AuthWrapper";
import RegisterForm from "@/components/auth/RegisterForm";
import { PLANS } from "@/server/billing/plans";
import { parseSubscribeIntent, subscribeIntentPath } from "@/lib/billing/intent";
import { getSiteConfig } from "@/server/config/site";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Metadata.auth");
  return {
    title: t("registerTitle"),
    description: t("registerDescription"),
    robots: {
      index: false,
      follow: false,
    },
  };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const RegisterPage = async ({ searchParams }: { searchParams: SearchParams }) => {
  const t = await getTranslations("Auth");
  const tRoot = await getTranslations();
  const params = await searchParams;
  // Step 8.5: `?plan=lite&interval=year` from the pricing page (only while billing is on).
  const intent = getSiteConfig().billingEnabled
    ? parseSubscribeIntent(one(params.plan), one(params.interval))
    : null;

  return (
    <AuthWrapper>
      <AuthCard
        page={t("registerTitle")}
        headerText={t("registerSubtitle", { credits: PLANS.FREE.credits })}
        backText={t("alreadyHaveAccount")}
        backLink="login"
        intent={intent}
      >
        {intent && (
          <p className="mb-4 rounded-xl border border-accent/30 bg-accent-soft/40 p-3 text-xs text-fg">
            {t("planIntent", {
              plan: tRoot(PLANS[intent.plan].name),
              interval: tRoot(`Billing.interval.${intent.interval}`),
            })}
          </p>
        )}
        <RegisterForm callbackURL={intent ? subscribeIntentPath(intent.plan, intent.interval) : undefined} />
      </AuthCard>
    </AuthWrapper>
  );
};

export default RegisterPage;
