import "server-only";
import { v2 as cloudinary } from "cloudinary";
import { env } from "@/server/env";
import { log, errInfo } from "@/server/log";
import {
  CreateSignatureOptions,
  SignedUploadPayload,
  StorageAssetMeta,
  StorageProvider,
  StorageResourceType,
  UploadBufferOptions,
  UploadBufferResult,
} from "./types";

export interface CloudinaryConfig {
  cloudName?: string;
  apiKey?: string;
  apiSecret?: string;
  /** Skip asking Cloudinary (env `CLOUDINARY_FOLDER_MODE`, or tests). */
  folderMode?: FolderMode;
}

export type FolderMode = "fixed" | "dynamic";

/** The folder part of a public id ("klecx/dev/speech/abc" → "klecx/dev/speech"); "" at the root. */
export function assetFolderOf(publicId: string): string {
  const i = publicId.lastIndexOf("/");
  return i > 0 ? publicId.slice(0, i) : "";
}

/** One lookup per process and account (the mode never changes for an account). */
const folderModeCache = new Map<string, Promise<FolderMode>>();

export class CloudinaryStorageProvider implements StorageProvider {
  public readonly name = "cloudinary";
  private readonly cloudName: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly configuredFolderMode: FolderMode | undefined;

  constructor(config?: CloudinaryConfig) {
    this.cloudName = config?.cloudName ?? env.CLOUDINARY_CLOUD_NAME ?? "";
    this.apiKey = config?.apiKey ?? env.CLOUDINARY_API_KEY ?? "";
    this.apiSecret = config?.apiSecret ?? env.CLOUDINARY_API_SECRET ?? "";
    this.configuredFolderMode = config?.folderMode ?? env.CLOUDINARY_FOLDER_MODE;

    if (this.cloudName && this.apiKey && this.apiSecret) {
      cloudinary.config({
        cloud_name: this.cloudName,
        api_key: this.apiKey,
        api_secret: this.apiSecret,
        secure: true,
      });
    }
  }

  /**
   * The account's folder mode (fixed 2026-11-24: on an account in dynamic
   * mode, files whose public id is "klecx/dev/speech/abc" sat at the Media
   * Library's root, because only `asset_folder` makes folders there).
   * `CLOUDINARY_FOLDER_MODE` wins; else Cloudinary's Admin API is asked once;
   * if that fails, "fixed" (the old behaviour: nothing extra is sent).
   */
  async folderMode(): Promise<FolderMode> {
    if (this.configuredFolderMode) return this.configuredFolderMode;
    let pending = folderModeCache.get(this.cloudName);
    if (!pending) {
      pending = Promise.resolve()
        .then(() => cloudinary.api.config({ settings: true }))
        .then((res) => (res?.settings?.folder_mode === "dynamic" ? "dynamic" : "fixed") as FolderMode)
        .catch((err: unknown) => {
          folderModeCache.delete(this.cloudName);
          log.warn({ err: errInfo(err) }, "[storage] could not read Cloudinary's folder mode; assuming fixed");
          return "fixed" as FolderMode;
        });
      folderModeCache.set(this.cloudName, pending);
    }
    return pending;
  }

  /** `asset_folder` to send with an upload: the public id's folder, in dynamic mode only. */
  private async assetFolderFor(publicId: string, folder?: string): Promise<string | undefined> {
    if ((await this.folderMode()) !== "dynamic") return undefined;
    const dir = assetFolderOf(publicId) || folder || "";
    return dir || undefined;
  }

  async createUploadSignature(
    options: CreateSignatureOptions
  ): Promise<SignedUploadPayload> {
    if (!this.cloudName || !this.apiKey || !this.apiSecret) {
      throw new Error("Cloudinary credentials are not configured");
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const resourceType = options.resourceType ?? "image";
    const type = options.isPublic ? "upload" : "authenticated";

    const paramsToSign: Record<string, string | number> = {
      public_id: options.publicId,
      timestamp,
      type,
    };

    // If public_id already includes a folder path (slashes), omit folder from signature and payload
    // so Cloudinary does not duplicate the folder name (e.g. folder/folder/id).
    const publicIdHasFolder = options.publicId.includes("/");
    const effectiveFolder = publicIdHasFolder ? "" : (options.folder ?? "");
    if (effectiveFolder) {
      paramsToSign.folder = effectiveFolder;
    }

    if (options.tags && options.tags.length > 0) {
      paramsToSign.tags = options.tags.join(",");
    }

    const assetFolder = await this.assetFolderFor(options.publicId, effectiveFolder);
    if (assetFolder) {
      paramsToSign.asset_folder = assetFolder;
    }

    const signature = cloudinary.utils.api_sign_request(
      paramsToSign,
      this.apiSecret
    );

    const uploadUrl = `https://api.cloudinary.com/v1_1/${this.cloudName}/${resourceType}/upload`;

    return {
      publicId: options.publicId,
      folder: effectiveFolder,
      ...(assetFolder ? { assetFolder } : {}),
      signature,
      timestamp,
      apiKey: this.apiKey,
      cloudName: this.cloudName,
      uploadUrl,
      resourceType,
      type,
      maxBytes: options.maxBytes,
      allowedFormats: options.allowedFormats,
    };
  }

  async uploadBuffer(
    buffer: Buffer,
    options: UploadBufferOptions
  ): Promise<UploadBufferResult> {
    if (!this.cloudName || !this.apiKey || !this.apiSecret) {
      throw new Error("Cloudinary credentials are not configured");
    }

    const resourceType = options.resourceType ?? "image";
    const type = options.isPublic ? "upload" : "authenticated";
    const publicIdHasFolder = options.publicId.includes("/");
    const effectiveFolder = publicIdHasFolder ? undefined : options.folder;
    const assetFolder = await this.assetFolderFor(options.publicId, effectiveFolder);

    return new Promise<UploadBufferResult>((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          public_id: options.publicId,
          folder: effectiveFolder,
          ...(assetFolder ? { asset_folder: assetFolder } : {}),
          resource_type: resourceType,
          type,
          format: options.format,
          tags: options.tags,
        },
        (error, result) => {
          if (error || !result) {
            return reject(
              error || new Error("Cloudinary upload_stream returned no result")
            );
          }
          resolve({
            publicId: String(result.public_id ?? options.publicId),
            bytes: Number(result.bytes ?? buffer.byteLength),
            format: String(
              result.format ??
                options.format ??
                options.mime?.split("/")[1] ??
                "png"
            ),
            width: result.width ? Number(result.width) : undefined,
            height: result.height ? Number(result.height) : undefined,
            resourceType: String(result.resource_type ?? resourceType),
          });
        }
      );

      uploadStream.end(buffer);
    });
  }

  async head(
    publicId: string,
    options?: { resourceType?: StorageResourceType; isPublic?: boolean; format?: string }
  ): Promise<StorageAssetMeta | null> {
    const resourceType = options?.resourceType ?? "image";
    const type = options?.isPublic ? "upload" : "authenticated";

    try {
      const res = await cloudinary.api.resource(publicId, {
        resource_type: resourceType,
        type,
      });

      return {
        bytes: Number(res.bytes ?? 0),
        format: String(res.format ?? ""),
        width: res.width ? Number(res.width) : undefined,
        height: res.height ? Number(res.height) : undefined,
        resourceType: String(res.resource_type ?? resourceType),
      };
    } catch (err: unknown) {
      const status =
        (err as { error?: { http_code?: number }; http_code?: number })
          ?.http_code ??
        (err as { error?: { http_code?: number } })?.error?.http_code;
      if (status === 404) {
        // Fallback: If raw file without extension in publicId, try with extension
        if (resourceType === "raw" && !publicId.includes(".") && options?.format) {
          try {
            const resWithExt = await cloudinary.api.resource(`${publicId}.${options.format}`, {
              resource_type: resourceType,
              type,
            });
            return {
              bytes: Number(resWithExt.bytes ?? 0),
              format: String(resWithExt.format ?? options.format),
              width: resWithExt.width ? Number(resWithExt.width) : undefined,
              height: resWithExt.height ? Number(resWithExt.height) : undefined,
              resourceType: String(resWithExt.resource_type ?? resourceType),
            };
          } catch {}
        }
        return null;
      }
      throw err;
    }
  }

  async delete(
    publicId: string,
    options?: { resourceType?: StorageResourceType; isPublic?: boolean }
  ): Promise<boolean> {
    const resourceType = options?.resourceType ?? "image";
    const type = options?.isPublic ? "upload" : "authenticated";

    try {
      const res = await cloudinary.uploader.destroy(publicId, {
        resource_type: resourceType,
        type,
        invalidate: true,
      });
      return res.result === "ok" || res.result === "not found";
    } catch {
      return false;
    }
  }

  async privateUrl(
    publicId: string,
    options?: {
      resourceType?: StorageResourceType;
      expiresInSeconds?: number;
      format?: string;
    }
  ): Promise<string> {
    const resourceType = options?.resourceType ?? "image";
    const expiresAt =
      Math.floor(Date.now() / 1000) + (options?.expiresInSeconds ?? 300);
    const format = options?.format ?? "";

    const signedUrl = cloudinary.utils.private_download_url(
      publicId,
      format,
      {
        resource_type: resourceType,
        type: "authenticated",
        expires_at: expiresAt,
      }
    );

    return signedUrl;
  }

  publicUrl(
    publicId: string,
    options?: {
      resourceType?: StorageResourceType;
      width?: number;
      height?: number;
      crop?: string;
      gravity?: string;
      format?: string;
      quality?: string;
      flags?: string;
    }
  ): string {
    const resourceType = options?.resourceType ?? "image";

    return cloudinary.url(publicId, {
      secure: true,
      resource_type: resourceType,
      type: "upload",
      width: options?.width,
      height: options?.height,
      crop: options?.crop ?? "fill",
      gravity: options?.gravity,
      fetch_format: options?.format ?? "auto",
      quality: options?.quality ?? "auto",
      flags: options?.flags,
    });
  }

  async downloadBuffer(
    publicId: string,
    options?: { resourceType?: StorageResourceType; isPublic?: boolean }
  ): Promise<Buffer> {
    const resourceType = options?.resourceType ?? "image";
    let downloadUrl: string;

    if (options?.isPublic) {
      // Fetch the untouched original bytes. Do NOT use publicUrl() here: its
      // default f_auto/q_auto/c_fill transformation makes Cloudinary transcode
      // the asset (e.g. WebP -> JPEG/PNG), which breaks magic-byte verification.
      downloadUrl = cloudinary.url(publicId, {
        secure: true,
        resource_type: resourceType,
        type: "upload",
      });
    } else {
      downloadUrl = await this.privateUrl(publicId, {
        resourceType,
        expiresInSeconds: 120,
      });
    }

    const res = await fetch(downloadUrl);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch asset from Cloudinary: ${res.status} ${res.statusText}`
      );
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
