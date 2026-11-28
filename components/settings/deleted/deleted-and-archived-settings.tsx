"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DELETED_PAGE_HREF, deletedPageTab, type DeletedPageTab } from "@/lib/settings/deleted-tabs";
import { ArchivedSettings } from "./archived-settings";
import { RecentlyDeletedSettings } from "./recently-deleted-settings";

/**
 * Pre-10.6 fix PR 8 (owner, 2026-11-28): Settings → Deleted & archived, one
 * page with two tabs instead of another Settings item. `?tab=archived` opens
 * the Archived tab; switching tabs keeps the address in step without a
 * server round trip.
 */
export function DeletedAndArchivedSettings({
  userId,
  initialTab,
}: {
  userId: string;
  initialTab: DeletedPageTab;
}) {
  const t = useTranslations("Settings.deleted");
  const [tab, setTab] = React.useState<DeletedPageTab>(initialTab);

  const onChange = (value: string) => {
    const next = deletedPageTab(value);
    setTab(next);
    const url = next === "archived" ? `${DELETED_PAGE_HREF}?tab=archived` : DELETED_PAGE_HREF;
    window.history.replaceState(window.history.state, "", url);
  };

  return (
    <Tabs value={tab} onValueChange={onChange} className="flex flex-col gap-4">
      <TabsList aria-label={t("tabsLabel")} className="self-start">
        <TabsTrigger value="deleted">{t("tabDeleted")}</TabsTrigger>
        <TabsTrigger value="archived">{t("tabArchived")}</TabsTrigger>
      </TabsList>
      <TabsContent value="deleted" className="mt-0 flex flex-col gap-4">
        <RecentlyDeletedSettings userId={userId} />
      </TabsContent>
      <TabsContent value="archived" className="mt-0 flex flex-col gap-4">
        <ArchivedSettings userId={userId} />
      </TabsContent>
    </Tabs>
  );
}
