-- AlterTable
ALTER TABLE "experiment_runs" ADD COLUMN     "judge_model" TEXT,
ADD COLUMN     "judge_prompt_version_id" UUID;

