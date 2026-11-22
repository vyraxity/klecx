import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requireActor } from "@/server/auth/session";
import { getUserAvatar } from "@/server/services/avatar";
import { getAccountIdentity } from "@/server/services/user-profile";
import UserProfileImage from "@/components/settings/UserProfileImage";
import { NameForm } from "@/components/settings/profile/name-form";
import { UsernameCard } from "@/components/settings/profile/username-card";
import { EmailCard } from "@/components/settings/profile/email-card";
import { OwnershipTransfersCard } from "@/components/settings/profile/ownership-transfers-card";
import { SettingsPageHeader, SettingsSection } from "@/components/settings/settings-section";
import Logout from "@/components/auth/Logout";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Settings.profilePage");
  return { title: t("title"), robots: { index: false, follow: false } };
}

/** Step 9.1: Settings → Profile. */
export default async function ProfileSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireActor();
  const t = await getTranslations("Settings.profilePage");
  const [identity, avatar, params] = await Promise.all([
    getAccountIdentity(actor.userId),
    getUserAvatar(actor.userId).catch(() => null),
    searchParams,
  ]);

  return (
    <>
      <SettingsPageHeader title={t("title")} description={t("description")} />

      <SettingsSection title={t("photoAndName")}>
        <div className="flex flex-col gap-5">
          <UserProfileImage
            user={{
              id: actor.userId,
              name: identity.name,
              email: identity.email,
              image: actor.image ?? "",
              token: 0,
            }}
            avatarUrl={avatar?.avatarUrl}
            isCustomAvatar={avatar?.isCustom}
          />
          <div className="border-t border-border pt-4">
            <NameForm initialName={identity.name} />
          </div>
        </div>
      </SettingsSection>

      <UsernameCard username={identity.username} claimed={Boolean(identity.usernameClaimedAt)} />
      <EmailCard email={identity.email} justChanged={params.email === "changed"} />
      <OwnershipTransfersCard userId={actor.userId} />

      <SettingsSection title={t("signOutTitle")} description={t("signOutHint")}>
        <Logout styleClass="w-full sm:w-auto justify-center px-4 py-2 rounded-xl bg-danger/10 border border-danger/25 text-danger hover:bg-danger hover:text-accent-fg transition-colors cursor-pointer" />
      </SettingsSection>
    </>
  );
}
