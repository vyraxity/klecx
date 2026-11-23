import "server-only";
import { env } from "@/server/env";
import { StorageProvider } from "./types";
import { CloudinaryStorageProvider } from "./cloudinary";
import { MockStorageProvider } from "./mock";

export * from "./types";

let currentProvider: StorageProvider | null = null;

export function getStorageProvider(): StorageProvider {
  if (currentProvider) {
    return currentProvider;
  }

  if (
    env.CLOUDINARY_CLOUD_NAME &&
    env.CLOUDINARY_API_KEY &&
    env.CLOUDINARY_API_SECRET
  ) {
    currentProvider = new CloudinaryStorageProvider();
  } else {
    currentProvider = new MockStorageProvider();
  }

  return currentProvider;
}

/**
 * Where this app's files live in storage: every upload goes under
 * CLOUDINARY_UPLOAD_FOLDER (e.g. "klecx/prod"), so nothing of the app is
 * scattered in the account's root. `storagePath("speech", key)` →
 * "klecx/prod/speech/<key>". Pass the result as the full `publicId`.
 */
export function storagePath(...parts: string[]): string {
  const base = (env.CLOUDINARY_UPLOAD_FOLDER || "klecx/dev").replace(/^\/+|\/+$/g, "");
  return [base, ...parts.map((p) => p.replace(/^\/+|\/+$/g, ""))].filter(Boolean).join("/");
}

export function setStorageProvider(provider: StorageProvider | null): void {
  currentProvider = provider;
}
