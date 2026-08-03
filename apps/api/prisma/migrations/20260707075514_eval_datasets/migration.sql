-- CreateTable
CREATE TABLE "datasets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "overall_feedback" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "datasets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dataset_examples" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "dataset_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "input" JSONB NOT NULL DEFAULT '{}',
    "criteria" TEXT,
    "source_trace_id" UUID,
    "source_feedback_id" UUID,
    "source_prompt_version_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dataset_examples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_datasets_team_time" ON "datasets"("team_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_datasets_team_deleted_at" ON "datasets"("team_id", "deleted_at");

-- CreateIndex
CREATE INDEX "idx_dataset_examples_dataset" ON "dataset_examples"("dataset_id");

-- AddForeignKey
ALTER TABLE "datasets" ADD CONSTRAINT "datasets_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "datasets" ADD CONSTRAINT "datasets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_examples" ADD CONSTRAINT "dataset_examples_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "datasets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_examples" ADD CONSTRAINT "dataset_examples_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_examples" ADD CONSTRAINT "dataset_examples_source_trace_id_fkey" FOREIGN KEY ("source_trace_id") REFERENCES "traces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_examples" ADD CONSTRAINT "dataset_examples_source_feedback_id_fkey" FOREIGN KEY ("source_feedback_id") REFERENCES "trace_feedback"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_examples" ADD CONSTRAINT "dataset_examples_source_prompt_version_id_fkey" FOREIGN KEY ("source_prompt_version_id") REFERENCES "prompt_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
