"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AtSign, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ClaimUsernameDialog } from "@/components/user/claim-username-dialog";
import { SettingsSection } from "@/components/settings/settings-section";

/**
 * Step 9.1: the username (Step 7.1). Everyone gets a generated one at sign-up
 * and can claim their own once; after that it's fixed.
 */
export function UsernameCard({
  username,
  claimed,
}: {
  username: string | null;
  claimed: boolean;
}) {
  const t = useTranslations("Settings.profilePage");
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [current, setCurrent] = React.useState(username);
  const [isClaimed, setIsClaimed] = React.useState(claimed);

  return (
    <SettingsSection
      title={t("usernameTitle")}
      description={isClaimed ? t("usernameClaimedHint") : t("usernameUnclaimedHint")}
      data-testid="settings-username"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-fg">
          <AtSign className="h-4 w-4 text-accent" aria-hidden />
          <span>{current ?? "—"}</span>
          {isClaimed && (
            <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
              <Check className="h-3 w-3" aria-hidden />
              {t("usernameClaimedBadge")}
            </span>
          )}
        </div>
        {!isClaimed && (
          <Button type="button" size="sm" onClick={() => setOpen(true)}>
            {t("usernameClaim")}
          </Button>
        )}
      </div>
      <ClaimUsernameDialog
        open={open}
        onOpenChange={setOpen}
        currentUsername={current}
        onSuccess={(next) => {
          setCurrent(next);
          setIsClaimed(true);
          toast.success(t("usernameClaimedToast", { username: next }));
          router.refresh();
        }}
      />
    </SettingsSection>
  );
}
