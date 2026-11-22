import * as React from "react";
import { cn } from "@/lib/utils";

/** Step 9.1: the heading at the top of each Settings page. */
export function SettingsPageHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-xl font-bold tracking-tight text-fg sm:text-2xl">{title}</h1>
      {description && <p className="text-sm text-muted">{description}</p>}
    </div>
  );
}

/** Step 9.1: a titled card inside a Settings page. */
export function SettingsSection({
  title,
  description,
  actions,
  children,
  className,
  ...props
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLElement>, "title">) {
  const headingId = React.useId();
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4 shadow-xs sm:p-5",
        className
      )}
      {...props}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="text-sm font-bold tracking-tight text-fg">
            {title}
          </h2>
          {description && <div className="mt-0.5 text-xs text-muted">{description}</div>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
