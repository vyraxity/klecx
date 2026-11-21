-- CreateTable
CREATE TABLE "billing_consents" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "plan" "PlanKey" NOT NULL,
    "interval" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "checkout_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_consents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "billing_consents_user_id_created_at_idx" ON "billing_consents"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "billing_consents" ADD CONSTRAINT "billing_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
