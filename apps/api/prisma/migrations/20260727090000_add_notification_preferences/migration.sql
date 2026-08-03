-- Who started an experiment run. Nullable: every run that exists today predates
-- this column, and a run started by a team-scoped API key has no acting user.
ALTER TABLE "experiment_runs" ADD COLUMN "created_by" UUID;

-- One row per (user, team, category) opt-OUT. No row means enabled, so nothing
-- is backfilled here and adding a category later needs no migration.
CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The upsert target. Also what makes unsubscribing twice a no-op rather than a
-- second row.
CREATE UNIQUE INDEX "notification_preferences_user_team_category"
    ON "notification_preferences"("user_id", "team_id", "category");

-- Serves the resolver's "which of these recipients opted out of this category"
-- lookup, which is per team + category.
CREATE INDEX "idx_notification_preferences_team_category"
    ON "notification_preferences"("team_id", "category");
