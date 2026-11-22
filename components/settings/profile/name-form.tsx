"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api/client";
import { getApiErrorMessage } from "@/lib/api/error-message";

/** Step 9.1: the display name, with an explicit Save and an "unsaved changes" hint. */
export function NameForm({ initialName }: { initialName: string }) {
  const t = useTranslations("Settings.profilePage");
  const tRoot = useTranslations();
  const router = useRouter();
  const [saved, setSaved] = React.useState(initialName);
  const [name, setName] = React.useState(initialName);
  const [saving, setSaving] = React.useState(false);
  const dirty = name.trim() !== saved;
  const invalid = name.trim().length === 0;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty || invalid) return;
    setSaving(true);
    try {
      const user = await api<{ name: string }>("/api/v1/me", {
        method: "PATCH",
        body: { name: name.trim() },
      });
      setSaved(user.name);
      setName(user.name);
      toast.success(t("nameSaved"));
      router.refresh();
    } catch (err) {
      toast.error(getApiErrorMessage(err, tRoot, t("nameSaveError")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2" data-testid="settings-name-form">
      <Label htmlFor="settings-name">{t("nameLabel")}</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="settings-name"
          value={name}
          maxLength={100}
          autoComplete="name"
          onChange={(e) => setName(e.target.value)}
          aria-invalid={invalid || undefined}
          className="sm:max-w-sm"
        />
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={!dirty || invalid || saving}>
            {saving && <Spinner size="sm" />}
            {t("save")}
          </Button>
          {dirty && (
            <Button type="button" size="sm" variant="ghost" onClick={() => setName(saved)} disabled={saving}>
              {t("discard")}
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-muted" aria-live="polite">
        {invalid ? t("nameRequired") : dirty ? t("unsavedChanges") : null}
      </p>
    </form>
  );
}
