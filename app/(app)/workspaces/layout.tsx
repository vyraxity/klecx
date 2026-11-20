import type { Metadata } from "next";
import { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { isImageGenerationEnabled } from "@/lib/features/image-generation";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Metadata");
  const tChat = await getTranslations("Chat");
  return {
    title: tChat("newChat"),
    // Text-only launch: no "visuals" while image generation is off.
    description: t(isImageGenerationEnabled() ? "description" : "descriptionTextOnly"),
  };
}

const layout = ({ children }: { children: ReactNode }) => {
  return <>{children}</>;
};

export default layout;
