import { Skeleton } from "@/components/ui/skeleton";

/** Step 9.1: shown while a Settings page loads (the nav stays). */
export default function SettingsLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" data-testid="settings-loading">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <Skeleton className="h-40 w-full rounded-2xl" />
      <Skeleton className="h-28 w-full rounded-2xl" />
    </div>
  );
}
