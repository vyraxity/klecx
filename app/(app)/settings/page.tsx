import { redirect } from "next/navigation";
import { SETTINGS_HOME } from "@/lib/settings/nav";

/** Step 9.1: `/settings` opens the first page (Profile). */
export default function SettingsIndexPage() {
  redirect(SETTINGS_HOME);
}
