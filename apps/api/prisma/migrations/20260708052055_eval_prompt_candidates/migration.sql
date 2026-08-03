-- AlterTable
ALTER TABLE "eval_results" ADD COLUMN     "prompt_candidate_id" UUID;

-- CreateTable
CREATE TABLE "prompt_candidates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "prompt_id" UUID NOT NULL,
    "experiment_run_id" UUID,
    "messages" JSONB NOT NULL,
    "rationale" TEXT,
    "label" TEXT NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_prompt_candidates_run" ON "prompt_candidates"("experiment_run_id");

-- AddForeignKey
ALTER TABLE "prompt_candidates" ADD CONSTRAINT "prompt_candidates_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_candidates" ADD CONSTRAINT "prompt_candidates_prompt_id_fkey" FOREIGN KEY ("prompt_id") REFERENCES "prompts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_candidates" ADD CONSTRAINT "prompt_candidates_experiment_run_id_fkey" FOREIGN KEY ("experiment_run_id") REFERENCES "experiment_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
