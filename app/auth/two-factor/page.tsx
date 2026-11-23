import { Suspense } from "react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import AuthWrapper from "@/components/auth/AuthWrapper";
import { TwoFactorChallengeForm } from "@/components/auth/TwoFactorChallengeForm";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Metadata.auth");
  return {
    title: t("twoFactorTitle"),
    description: t("twoFactorDescription"),
    robots: { index: false, follow: false },
  };
}

/** Two-factor sign-in: the code after the password. */
export default function TwoFactorPage() {
  return (
    <AuthWrapper>
      <Suspense fallback={<div className="h-80" />}>
        <TwoFactorChallengeForm />
      </Suspense>
    </AuthWrapper>
  );
}
