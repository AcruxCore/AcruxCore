-- CreateEnum
CREATE TYPE "experiment_run_kind" AS ENUM ('evaluation', 'optimize', 'local');

-- AlterTable
ALTER TABLE "experiment_runs" ADD COLUMN     "kind" "experiment_run_kind" NOT NULL DEFAULT 'evaluation',
ADD COLUMN     "optimizer_rejections" JSONB;

-- Backfill (issue #684). Until now the kind was read off the grid: a `local`
-- cell means a local run, a `candidate` cell an optimize run.
UPDATE "experiment_runs"
SET "kind" = 'local'
WHERE "grid" @> '[{"variantKind": "local"}]'::jsonb;

UPDATE "experiment_runs"
SET "kind" = 'optimize'
WHERE "kind" = 'evaluation'
  AND "grid" @> '[{"variantKind": "candidate"}]'::jsonb;

-- An optimize run that failed before drafting has an empty grid. Its
-- experiment is the one `startOptimize` creates: named `optimize`, with no
-- versions in its config. A user-created experiment always has at least one.
UPDATE "experiment_runs" r
SET "kind" = 'optimize'
FROM "experiments" e
WHERE r."experiment_id" = e."id"
  AND r."kind" = 'evaluation'
  AND r."grid" = '[]'::jsonb
  AND e."name" = 'optimize'
  AND e."config" -> 'versionIds' = '[]'::jsonb;
