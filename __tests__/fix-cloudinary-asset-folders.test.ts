/**
 * @jest-environment node
 *
 * Fix (2026-11-24, found on dev.klecx.com): on a Cloudinary account in DYNAMIC
 * folder mode, the Media Library folder comes from `asset_folder`, not from
 * the slashes in the public id, so every file sat at the root. Uploads now
 * send `asset_folder` (the public id's folder) in dynamic mode, signed for
 * browser uploads; fixed mode is unchanged.
 */
const mockConfig = jest.fn();
const mockUploadStream = jest.fn();

jest.mock("cloudinary", () => {
  const actual = jest.requireActual("cloudinary");
  return {
    v2: {
      ...actual.v2,
      config: jest.fn(),
      utils: actual.v2.utils,
      api: { ...actual.v2.api, config: (...a: unknown[]) => mockConfig(...a) },
      uploader: { ...actual.v2.uploader, upload_stream: (...a: unknown[]) => mockUploadStream(...a) },
    },
  };
});

import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorageProvider, assetFolderOf } from "@/server/storage/cloudinary";

const SECRET = "test-secret-not-real";
let n = 0;
const make = (folderMode?: "fixed" | "dynamic") =>
  // A distinct cloud name per provider, so the folder-mode cache doesn't leak between tests.
  new CloudinaryStorageProvider({ cloudName: `cloud-${++n}`, apiKey: "123456789012345", apiSecret: SECRET, folderMode });

beforeEach(() => {
  mockConfig.mockReset();
  mockUploadStream.mockReset();
  mockUploadStream.mockImplementation((opts: Record<string, unknown>, cb: (e: unknown, r: unknown) => void) => ({
    end: () => cb(null, { public_id: opts.public_id, bytes: 3, format: "mp3", resource_type: opts.resource_type }),
  }));
});

test("assetFolderOf takes the folder part of a public id", () => {
  expect(assetFolderOf("klecx_dev/speech/abc")).toBe("klecx_dev/speech");
  expect(assetFolderOf("abc")).toBe("");
});

describe("dynamic folder mode", () => {
  test("a server upload sends asset_folder = the public id's folder (the mode is asked once)", async () => {
    mockConfig.mockResolvedValue({ cloud_name: "x", settings: { folder_mode: "dynamic" } });
    const storage = make();
    await storage.uploadBuffer(Buffer.from("mp3"), { publicId: "klecx_dev/speech/abc", resourceType: "video", format: "mp3" });
    await storage.uploadBuffer(Buffer.from("mp3"), { publicId: "klecx_dev/exports/u/1", resourceType: "raw" });
    expect(mockUploadStream.mock.calls[0][0]).toMatchObject({ public_id: "klecx_dev/speech/abc", asset_folder: "klecx_dev/speech" });
    expect(mockUploadStream.mock.calls[1][0]).toMatchObject({ asset_folder: "klecx_dev/exports/u" });
    expect(mockConfig).toHaveBeenCalledTimes(1);
  });

  test("a browser upload's signature covers asset_folder, and the payload carries it", async () => {
    const storage = make("dynamic");
    const p = await storage.createUploadSignature({ publicId: "klecx_dev/ws1/file1", folder: "klecx_dev/ws1", resourceType: "image" });
    expect(p.assetFolder).toBe("klecx_dev/ws1");
    const expected = cloudinary.utils.api_sign_request(
      { public_id: "klecx_dev/ws1/file1", timestamp: p.timestamp, type: "authenticated", asset_folder: "klecx_dev/ws1" },
      SECRET
    );
    expect(p.signature).toBe(expected);
    expect(mockConfig).not.toHaveBeenCalled(); // CLOUDINARY_FOLDER_MODE / config wins
  });
});

describe("fixed folder mode (unchanged)", () => {
  test("no asset_folder is sent or signed", async () => {
    mockConfig.mockResolvedValue({ cloud_name: "x", settings: { folder_mode: "fixed" } });
    const storage = make();
    await storage.uploadBuffer(Buffer.from("x"), { publicId: "klecx/dev/speech/abc", resourceType: "video" });
    expect(mockUploadStream.mock.calls[0][0]).not.toHaveProperty("asset_folder");
    const p = await storage.createUploadSignature({ publicId: "klecx/dev/ws/f", resourceType: "image" });
    expect(p.assetFolder).toBeUndefined();
    expect(p.signature).toBe(
      cloudinary.utils.api_sign_request({ public_id: "klecx/dev/ws/f", timestamp: p.timestamp, type: "authenticated" }, SECRET)
    );
  });

  test("if Cloudinary can't be asked, uploads behave as before (fixed)", async () => {
    mockConfig.mockRejectedValue(new Error("no admin access"));
    const storage = make();
    await storage.uploadBuffer(Buffer.from("x"), { publicId: "klecx/dev/a/b", resourceType: "image" });
    expect(mockUploadStream.mock.calls[0][0]).not.toHaveProperty("asset_folder");
  });
});
