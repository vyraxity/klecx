import AuthWrapper from "@/components/auth/AuthWrapper";
import VerificationForm from "@/components/auth/VerificationForm";
import React, { Suspense } from "react";
import { getTranslations } from "next-intl/server";

const VerificationPage = async () => {
  const tCommon = await getTranslations("Common");
  return (
    <AuthWrapper>
      <Suspense fallback={<div className="text-sm">{tCommon("loading")}</div>}>
        <VerificationForm />
      </Suspense>
    </AuthWrapper>
  );
};

export default VerificationPage;
