-- CreateEnum
CREATE TYPE "experiment_run_status" AS ENUM ('queued', 'running', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "experiments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "dataset_id" UUID NOT NULL,
    "prompt_id" UUID,
    "name" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "experiments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experiment_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "experiment_id" UUID NOT NULL,
    "status" "experiment_run_status" NOT NULL DEFAULT 'queued',
    "example_snapshot" JSONB NOT NULL DEFAULT '[]',
    "grid" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "experiment_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_results" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "experiment_run_id" UUID NOT NULL,
    "dataset_example_id" UUID NOT NULL,
    "variant_kind" TEXT NOT NULL,
    "prompt_version_id" UUID,
    "variant_label" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "output" JSONB,
    "trace_id" UUID,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eval_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_experiments_team_time" ON "experiments"("team_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_experiment_runs_team_time" ON "experiment_runs"("team_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_experiment_runs_experiment" ON "experiment_runs"("experiment_id");

-- CreateIndex
CREATE INDEX "idx_eval_results_run" ON "eval_results"("experiment_run_id");

-- AddForeignKey
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "datasets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_prompt_id_fkey" FOREIGN KEY ("prompt_id") REFERENCES "prompts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiment_runs" ADD CONSTRAINT "experiment_runs_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiment_runs" ADD CONSTRAINT "experiment_runs_experiment_id_fkey" FOREIGN KEY ("experiment_id") REFERENCES "experiments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_experiment_run_id_fkey" FOREIGN KEY ("experiment_run_id") REFERENCES "experiment_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_dataset_example_id_fkey" FOREIGN KEY ("dataset_example_id") REFERENCES "dataset_examples"("id") ON DELETE CASCADE ON UPDATE CASCADE;
