-- AlterTable
ALTER TABLE "spans" ADD COLUMN     "metadata" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
