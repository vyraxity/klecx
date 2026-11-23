import * as React from "react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import AuthWrapper from "@/components/auth/AuthWrapper";
import { RestoreAccountForm } from "@/components/account/restore-account-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("AccountRestore");
  return { title: t("title"), robots: { index: false, follow: false } };
}

/** Step 9.5: the link in the account-deletion email lands here. */
export default function RestoreAccountPage() {
  return (
    <AuthWrapper>
      <React.Suspense fallback={<div className="h-40" />}>
        <RestoreAccountForm />
      </React.Suspense>
    </AuthWrapper>
  );
}
