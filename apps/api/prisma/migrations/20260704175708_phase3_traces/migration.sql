-- CreateEnum
CREATE TYPE "span_kind" AS ENUM ('llm', 'tool', 'retrieval', 'embedding', 'agent', 'chain', 'other');

-- CreateEnum
CREATE TYPE "span_status" AS ENUM ('ok', 'error', 'unset');

-- AlterEnum
ALTER TYPE "AuditEvent" ADD VALUE 'trace_settings_updated';

-- CreateTable
CREATE TABLE "traces" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "session_id" TEXT,
    "name" TEXT,
    "status" "span_status" NOT NULL DEFAULT 'unset',
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "span_count" INTEGER NOT NULL DEFAULT 0,
    "total_cost_usd" DECIMAL(18,9),
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "traces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "trace_id" UUID NOT NULL,
    "span_ref" TEXT NOT NULL,
    "parent_span_ref" TEXT,
    "kind" "span_kind" NOT NULL DEFAULT 'other',
    "name" TEXT NOT NULL,
    "status" "span_status" NOT NULL DEFAULT 'unset',
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "latency_ms" INTEGER,
    "model" TEXT,
    "provider" TEXT,
    "prompt_tokens" INTEGER,
    "completion_tokens" INTEGER,
    "total_tokens" INTEGER,
    "cost_usd" DECIMAL(18,9),
    "prompt_version_id" UUID,
    "gateway_request_id" UUID,
    "error_message" TEXT,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "span_payloads" (
    "span_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "input" JSONB,
    "output" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "span_payloads_pkey" PRIMARY KEY ("span_id")
);

-- CreateTable
CREATE TABLE "team_trace_settings" (
    "team_id" UUID NOT NULL,
    "capture_payloads" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_trace_settings_pkey" PRIMARY KEY ("team_id")
);

-- CreateIndex
CREATE INDEX "idx_traces_team_time" ON "traces"("team_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_traces_team_session" ON "traces"("team_id", "session_id");

-- CreateIndex
CREATE INDEX "idx_spans_team_time" ON "spans"("team_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_spans_trace" ON "spans"("trace_id");

-- CreateIndex
CREATE INDEX "idx_spans_prompt_version" ON "spans"("prompt_version_id");

-- CreateIndex
CREATE INDEX "idx_spans_team_model" ON "spans"("team_id", "model");

-- CreateIndex
CREATE UNIQUE INDEX "uq_spans_trace_ref" ON "spans"("trace_id", "span_ref");

-- AddForeignKey
ALTER TABLE "traces" ADD CONSTRAINT "traces_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spans" ADD CONSTRAINT "spans_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spans" ADD CONSTRAINT "spans_trace_id_fkey" FOREIGN KEY ("trace_id") REFERENCES "traces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spans" ADD CONSTRAINT "spans_prompt_version_id_fkey" FOREIGN KEY ("prompt_version_id") REFERENCES "prompt_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spans" ADD CONSTRAINT "spans_gateway_request_id_fkey" FOREIGN KEY ("gateway_request_id") REFERENCES "gateway_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "span_payloads" ADD CONSTRAINT "span_payloads_span_id_fkey" FOREIGN KEY ("span_id") REFERENCES "spans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "span_payloads" ADD CONSTRAINT "span_payloads_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_trace_settings" ADD CONSTRAINT "team_trace_settings_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
