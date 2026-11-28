-- CreateTable
CREATE TABLE "feature_flags" (
    "key" TEXT NOT NULL,
    "reason" TEXT,
    "updated_by_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("key")
);
