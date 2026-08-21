-- AlterTable
ALTER TABLE "eval_rules" ADD COLUMN     "judge_prompt_id" UUID;

-- CreateIndex
CREATE INDEX "idx_eval_rules_judge_prompt" ON "eval_rules"("judge_prompt_id");

-- AddForeignKey
ALTER TABLE "eval_rules" ADD CONSTRAINT "eval_rules_judge_prompt_id_fkey" FOREIGN KEY ("judge_prompt_id") REFERENCES "prompts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
