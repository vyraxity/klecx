/**
 * Step 10.5: file sizes in the reader's language ("1.5 KB", "1,5 ko", "1,5 kB"),
 * through Intl units rather than English text.
 */
export function formatFileSize(bytes: number | null | undefined, locale: string): string {
  if (!bytes || bytes <= 0) return "";
  const fmt = (value: number, unit: "byte" | "kilobyte" | "megabyte") =>
    new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "short", maximumFractionDigits: unit === "byte" ? 0 : 1 }).format(value);
  if (bytes < 1024) return fmt(bytes, "byte");
  const kb = bytes / 1024;
  if (kb < 1024) return fmt(kb, "kilobyte");
  return fmt(kb / 1024, "megabyte");
}
