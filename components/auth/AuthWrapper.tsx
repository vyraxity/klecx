import { ReactNode } from "react";
import Link from "next/link";
import Logo from "../logo/Logo";
import AppName from "../logo/AppName";
import LocaleSwitcher from "@/components/layout/locale-switcher";
import { CleanStaleAuthCookies } from "./CleanStaleAuthCookies";
import { MAIN_CONTENT_ID } from "@/components/layout/skip-link";
import { getSiteConfig } from "@/server/config/site";

const AuthWrapper = ({ children }: { children: ReactNode }) => {
  const site = getSiteConfig();
  return (
    <div className="min-h-screen w-full flex flex-col justify-between bg-bg relative overflow-hidden px-4 py-6">
      <CleanStaleAuthCookies />
      {/* Ambient Radial Accents */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 w-[500px] h-[300px] rounded-full bg-accent-soft blur-3xl"
      />

      {/* Top Navigation Bar */}
      <header className="w-full max-w-6xl mx-auto flex items-center justify-between z-20">
        <Link href="/" className="flex items-center gap-2">
          <Logo size="icon" />
          <AppName />
        </Link>
        <LocaleSwitcher />
      </header>

      {/* Main Centered Auth Card (Step 10.5: the page's main landmark) */}
      <main id={MAIN_CONTENT_ID} className="w-full flex-grow flex justify-center items-center py-8 z-20">
        {children}
      </main>

      <footer className="text-center text-xs text-subtle z-20">
        {`© ${new Date().getFullYear()} ${site.appName}`}
      </footer>
    </div>
  );
};

export default AuthWrapper;
