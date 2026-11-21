"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Checkbox } from "@/components/ui/checkbox";
import { REFUND_POLICY_HREF } from "@/lib/billing/links";

/**
 * Step 8.5: consent to immediate start, required before every checkout and
 * upgrade (`lib/billing/consent.ts`). The buttons it guards stay disabled
 * until it is ticked; the server checks it again.
 */
export function ConsentCheckbox({
  checked,
  onCheckedChange,
  id = "billing-consent",
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  id?: string;
}) {
  const t = useTranslations("Billing.consent");
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface-2/60 p-3">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        className="mt-0.5"
      />
      <label htmlFor={id} className="text-xs leading-relaxed text-fg cursor-pointer">
        {t("label")}{" "}
        <Link href={REFUND_POLICY_HREF} className="underline underline-offset-2 hover:text-accent" target="_blank">
          {t("policyLink")}
        </Link>
      </label>
    </div>
  );
}
