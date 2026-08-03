-- AlterTable
ALTER TABLE "prompt_versions" ADD COLUMN     "model_id" UUID;

-- CreateIndex
CREATE INDEX "idx_prompt_versions_model_id" ON "prompt_versions"("model_id");

-- AddForeignKey
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "gateway_models"("id") ON DELETE SET NULL ON UPDATE CASCADE;
