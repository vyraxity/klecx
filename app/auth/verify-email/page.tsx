import * as React from "react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import AuthWrapper from "@/components/auth/AuthWrapper";
import VerificationForm from "@/components/auth/VerificationForm";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Metadata.auth");
  return {
    title: t("verifyEmailTitle"),
    description: t("verifyEmailDescription"),
    robots: {
      index: false,
      follow: false,
    },
  };
}

export default async function VerifyEmailPage() {
  const tAuth = await getTranslations("Auth");
  return (
    <AuthWrapper>
      <React.Suspense fallback={<div className="text-xs text-fg-subtle">{tAuth("verifyingTitle")}</div>}>
        <VerificationForm />
      </React.Suspense>
    </AuthWrapper>
  );
}
