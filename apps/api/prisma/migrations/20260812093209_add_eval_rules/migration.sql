-- CreateEnum
CREATE TYPE "eval_rule_kind" AS ENUM ('llm_judge');

-- CreateTable
CREATE TABLE "eval_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "kind" "eval_rule_kind" NOT NULL DEFAULT 'llm_judge',
    "criteria" TEXT NOT NULL,
    "judge_model" TEXT,
    "sample_rate" DECIMAL(4,3) NOT NULL DEFAULT 0.1,
    "daily_limit" INTEGER DEFAULT 500,
    "alert_below" INTEGER,
    "filter" JSONB NOT NULL DEFAULT '{}',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eval_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_rule_scores" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "trace_id" UUID NOT NULL,
    "span_id" UUID NOT NULL,
    "score" INTEGER,
    "passed" BOOLEAN,
    "reason" TEXT,
    "judge_trace_id" UUID,
    "cost_usd" DECIMAL(18,9),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eval_rule_scores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_eval_rules_team_enabled" ON "eval_rules"("team_id", "enabled");

-- CreateIndex
CREATE INDEX "idx_eval_rule_scores_team_time" ON "eval_rule_scores"("team_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_eval_rule_scores_span" ON "eval_rule_scores"("span_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_eval_rule_scores_rule_span" ON "eval_rule_scores"("rule_id", "span_id");

-- AddForeignKey
ALTER TABLE "eval_rules" ADD CONSTRAINT "eval_rules_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_rules" ADD CONSTRAINT "eval_rules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_rule_scores" ADD CONSTRAINT "eval_rule_scores_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_rule_scores" ADD CONSTRAINT "eval_rule_scores_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "eval_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
