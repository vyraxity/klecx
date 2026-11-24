-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "email_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "email_next_attempt_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "job_locks" (
    "job" TEXT NOT NULL,
    "locked_until" TIMESTAMP(3) NOT NULL,
    "holder" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_locks_pkey" PRIMARY KEY ("job")
);

-- CreateTable
CREATE TABLE "job_runs" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "result" JSONB,
    "error_code" TEXT,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_runs_job_started_at_idx" ON "job_runs"("job", "started_at" DESC);

-- CreateIndex
CREATE INDEX "job_runs_started_at_idx" ON "job_runs"("started_at");

-- CreateIndex
CREATE INDEX "notifications_email_status_email_next_attempt_at_idx" ON "notifications"("email_status", "email_next_attempt_at");
