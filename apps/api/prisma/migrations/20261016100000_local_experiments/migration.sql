-- AlterTable
ALTER TABLE "dataset_examples" ADD COLUMN     "expected" JSONB;

-- AlterTable
ALTER TABLE "eval_results" ADD COLUMN     "scores" JSONB;

