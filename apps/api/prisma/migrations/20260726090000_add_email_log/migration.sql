-- Recipient of an emailed invite. Nullable: copy-link invites (every invite
-- that exists today) have no recipient address.
ALTER TABLE "team_invites" ADD COLUMN "email" TEXT;

-- Routing metadata for every outbound product email. No body column by design:
-- the invite email embeds a live invite token.
CREATE TABLE "email_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "to_email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "provider_message_id" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "sent_at" TIMESTAMPTZ(6),

    CONSTRAINT "email_log_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "email_log" ADD CONSTRAINT "email_log_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Recent-sends listing per team.
CREATE INDEX "idx_email_log_team_time" ON "email_log"("team_id", "created_at" DESC);

-- Serves the invite abuse cap, which counts (team_id, type) rows in a time window.
CREATE INDEX "idx_email_log_team_type_time" ON "email_log"("team_id", "type", "created_at" DESC);
