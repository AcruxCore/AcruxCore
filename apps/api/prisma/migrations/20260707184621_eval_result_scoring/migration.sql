-- AlterTable
ALTER TABLE "eval_results" ADD COLUMN     "judge_trace_id" UUID,
ADD COLUMN     "passed" BOOLEAN,
ADD COLUMN     "reason" TEXT,
ADD COLUMN     "score" INTEGER;
