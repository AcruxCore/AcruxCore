-- CreateTable
CREATE TABLE "prompt_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "prompt_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "messages" JSONB NOT NULL,
    "variables" JSONB NOT NULL DEFAULT '[]',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_aliases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "prompt_id" UUID NOT NULL,
    "alias" TEXT NOT NULL,
    "version_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_prompt_versions_lookup" ON "prompt_versions"("prompt_id", "version_number");

-- CreateIndex
CREATE INDEX "idx_prompt_versions_list" ON "prompt_versions"("prompt_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_versions_prompt_id_version_number_key" ON "prompt_versions"("prompt_id", "version_number");

-- CreateIndex
CREATE INDEX "idx_prompt_aliases_lookup" ON "prompt_aliases"("prompt_id", "alias");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_aliases_prompt_id_alias_key" ON "prompt_aliases"("prompt_id", "alias");

-- AddForeignKey
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_prompt_id_fkey" FOREIGN KEY ("prompt_id") REFERENCES "prompts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_aliases" ADD CONSTRAINT "prompt_aliases_prompt_id_fkey" FOREIGN KEY ("prompt_id") REFERENCES "prompts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_aliases" ADD CONSTRAINT "prompt_aliases_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "prompt_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
