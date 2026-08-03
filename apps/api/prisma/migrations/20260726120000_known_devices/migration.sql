-- Device memory for the "new sign-in" security email.
--
-- `auth_sessions` cannot serve this purpose: signing out deletes the row, so a
-- normal sign-out/sign-in cycle would be indistinguishable from an intruder and
-- the alert would fire constantly until people stopped reading it.
--
-- Only a hash is stored. The raw IP and user-agent are needed once, in the body
-- of the email, and are not worth keeping indefinitely afterwards.
CREATE TABLE "known_devices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "known_devices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "known_devices_user_fingerprint" ON "known_devices"("user_id", "fingerprint");
ALTER TABLE "known_devices" ADD CONSTRAINT "known_devices_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
