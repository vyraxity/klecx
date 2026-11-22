-- CreateEnum
CREATE TYPE "ThemePreference" AS ENUM ('SYSTEM', 'LIGHT', 'DARK');

-- AlterTable
ALTER TABLE "user_preferences" ADD COLUMN     "enter_to_send" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "onboarding_dismissed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reduce_motion" BOOLEAN,
ADD COLUMN     "theme" "ThemePreference",
ADD COLUMN     "voice_id" TEXT,
ADD COLUMN     "voice_provider" TEXT,
ADD COLUMN     "voice_speed" DOUBLE PRECISION NOT NULL DEFAULT 1;
