-- CreateEnum
CREATE TYPE "ToolVersionSource" AS ENUM ('code', 'dashboard', 'api');

-- AlterEnum
ALTER TYPE "AuditEvent" ADD VALUE 'tool_version_superseded';

-- AlterTable
ALTER TABLE "tool_versions" ADD COLUMN     "changelog" TEXT,
ADD COLUMN     "source" "ToolVersionSource" NOT NULL DEFAULT 'api';
