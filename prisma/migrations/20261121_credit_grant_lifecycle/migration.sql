-- AlterTable
ALTER TABLE "credit_accounts" ADD COLUMN     "allowance_key" TEXT,
ADD COLUMN     "allowance_plan" "PlanKey" NOT NULL DEFAULT 'FREE';

-- AlterTable
ALTER TABLE "member_limit_grace" ADD COLUMN     "enforced_at" TIMESTAMP(3);

-- Accounts that already hold a paid allowance (granted by the Step 8.3 webhook)
-- record that plan, so the lazy grant (Step 8.4) expires it when the plan ends.
UPDATE "credit_accounts" AS ca
SET "allowance_plan" = s."plan"
FROM "subscriptions" AS s
WHERE s."user_id" = ca."user_id"
  AND s."last_grant_period" IS NOT NULL
  AND s."plan" <> 'FREE';
