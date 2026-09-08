-- A named, team-visible filter set for the trace or feedback list.
CREATE TABLE "saved_views" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "surface" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_views_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One name per surface per team: a second "Checkout regressions" on the trace
-- list is a rename, not a new view.
CREATE UNIQUE INDEX "uq_saved_views_team_surface_name" ON "saved_views" ("team_id", "surface", "name");

CREATE INDEX "idx_saved_views_team_surface" ON "saved_views" ("team_id", "surface");
