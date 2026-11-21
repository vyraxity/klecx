import { ReactNode } from "react";

export interface AuthCardProps {
  children: ReactNode;
  page: string;
  headerText: string;
  backText: string;
  backLink: "register" | "login";
  /** Step 8.5: a plan chosen on the pricing page, carried to the other auth page and OAuth sign-in. */
  intent?: { plan: "LITE" | "STANDARD" | "PRO"; interval: "month" | "year" } | null;
}
