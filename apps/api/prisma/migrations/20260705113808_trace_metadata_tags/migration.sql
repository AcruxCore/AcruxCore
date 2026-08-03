-- AlterTable
ALTER TABLE "traces" DROP COLUMN "attributes",
ADD COLUMN     "metadata" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "idx_traces_tags_gin" ON "traces" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "idx_traces_metadata_gin" ON "traces" USING GIN ("metadata");
