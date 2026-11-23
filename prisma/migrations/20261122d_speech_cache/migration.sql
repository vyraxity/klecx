-- CreateTable
CREATE TABLE "speech_cache" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "voice_id" TEXT NOT NULL,
    "chars" INTEGER NOT NULL,
    "seconds" DOUBLE PRECISION NOT NULL,
    "storage_id" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "speech_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "speech_cache_key_key" ON "speech_cache"("key");

-- CreateIndex
CREATE INDEX "speech_cache_last_used_at_idx" ON "speech_cache"("last_used_at");
