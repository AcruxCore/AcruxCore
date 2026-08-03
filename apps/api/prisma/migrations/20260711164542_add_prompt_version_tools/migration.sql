-- CreateTable
CREATE TABLE "prompt_version_tools" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "prompt_version_id" UUID NOT NULL,
    "tool_id" UUID NOT NULL,
    "alias_name" TEXT NOT NULL DEFAULT 'production',
    "pinned_version_id" UUID,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "prompt_version_tools_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_prompt_version_tools_pv" ON "prompt_version_tools"("prompt_version_id");

-- CreateIndex
CREATE INDEX "idx_prompt_version_tools_tool" ON "prompt_version_tools"("tool_id");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_version_tools_prompt_version_id_tool_id_key" ON "prompt_version_tools"("prompt_version_id", "tool_id");

-- AddForeignKey
ALTER TABLE "prompt_version_tools" ADD CONSTRAINT "prompt_version_tools_prompt_version_id_fkey" FOREIGN KEY ("prompt_version_id") REFERENCES "prompt_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_version_tools" ADD CONSTRAINT "prompt_version_tools_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "tools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_version_tools" ADD CONSTRAINT "prompt_version_tools_pinned_version_id_fkey" FOREIGN KEY ("pinned_version_id") REFERENCES "tool_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

