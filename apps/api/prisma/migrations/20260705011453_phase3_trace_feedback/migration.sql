-- CreateTable
CREATE TABLE "trace_feedback" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "trace_id" UUID NOT NULL,
    "span_id" UUID,
    "rating" INTEGER,
    "label" TEXT,
    "comment" TEXT,
    "source" TEXT NOT NULL DEFAULT 'user',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trace_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_trace_feedback_trace" ON "trace_feedback"("trace_id");

-- CreateIndex
CREATE INDEX "idx_trace_feedback_team_time" ON "trace_feedback"("team_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "trace_feedback" ADD CONSTRAINT "trace_feedback_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trace_feedback" ADD CONSTRAINT "trace_feedback_trace_id_fkey" FOREIGN KEY ("trace_id") REFERENCES "traces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trace_feedback" ADD CONSTRAINT "trace_feedback_span_id_fkey" FOREIGN KEY ("span_id") REFERENCES "spans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trace_feedback" ADD CONSTRAINT "trace_feedback_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
