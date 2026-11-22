-- CreateEnum
CREATE TYPE "DensityPreference" AS ENUM ('COMFORTABLE', 'COMPACT');

-- AlterTable
ALTER TABLE "user_preferences" ADD COLUMN     "density" "DensityPreference" NOT NULL DEFAULT 'COMFORTABLE';
