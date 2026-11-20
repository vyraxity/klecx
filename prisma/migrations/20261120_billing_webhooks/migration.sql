-- AlterTable
ALTER TABLE "billing_events" ADD COLUMN     "user_id" TEXT;

-- CreateTable
CREATE TABLE "billing_checkouts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "plan" "PlanKey" NOT NULL,
    "interval" TEXT NOT NULL,
    "provider_checkout_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_checkouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "billing_checkouts_user_id_created_at_idx" ON "billing_checkouts"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "billing_events_user_id_received_at_idx" ON "billing_events"("user_id", "received_at");

-- AddForeignKey
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
