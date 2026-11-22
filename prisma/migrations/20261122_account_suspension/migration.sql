-- AlterTable
ALTER TABLE "credit_accounts" ADD COLUMN     "frozen_at" TIMESTAMP(3),
ADD COLUMN     "frozen_reason" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "suspended_at" TIMESTAMP(3),
ADD COLUMN     "suspended_reason" TEXT;
