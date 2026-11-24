-- AlterTable
ALTER TABLE "generations" ADD COLUMN     "first_token_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "usage_limit_hits" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "first_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_limit_hits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitoring_alerts" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "details" JSONB,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_sent_at" TIMESTAMP(3),
    "occurrences" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "monitoring_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "usage_limit_hits_day_idx" ON "usage_limit_hits"("day");

-- CreateIndex
CREATE UNIQUE INDEX "usage_limit_hits_user_id_kind_day_key" ON "usage_limit_hits"("user_id", "kind", "day");

-- CreateIndex
CREATE UNIQUE INDEX "monitoring_alerts_key_key" ON "monitoring_alerts"("key");

-- CreateIndex
CREATE INDEX "monitoring_alerts_last_seen_at_idx" ON "monitoring_alerts"("last_seen_at");
