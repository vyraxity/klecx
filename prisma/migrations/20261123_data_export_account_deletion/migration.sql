-- CreateEnum
CREATE TYPE "DataExportStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "data_exports" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "DataExportStatus" NOT NULL DEFAULT 'PENDING',
    "storage_id" TEXT,
    "bytes" INTEGER,
    "files_included" INTEGER NOT NULL DEFAULT 0,
    "files_skipped" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "data_exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_deletions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purge_after" TIMESTAMP(3) NOT NULL,
    "restore_token_hash" TEXT NOT NULL,
    "purged_at" TIMESTAMP(3),

    CONSTRAINT "account_deletions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "data_exports_user_id_created_at_idx" ON "data_exports"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "data_exports_expires_at_idx" ON "data_exports"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "account_deletions_user_id_key" ON "account_deletions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_deletions_restore_token_hash_key" ON "account_deletions"("restore_token_hash");

-- CreateIndex
CREATE INDEX "account_deletions_purge_after_purged_at_idx" ON "account_deletions"("purge_after", "purged_at");

-- AddForeignKey
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_deletions" ADD CONSTRAINT "account_deletions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
