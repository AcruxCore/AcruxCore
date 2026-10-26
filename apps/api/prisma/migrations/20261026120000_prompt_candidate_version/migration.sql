-- AlterTable
ALTER TABLE "prompt_candidates" ADD COLUMN     "version_id" UUID;

-- AddForeignKey
ALTER TABLE "prompt_candidates" ADD CONSTRAINT "prompt_candidates_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "prompt_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

