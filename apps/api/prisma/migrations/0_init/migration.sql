-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "team_role" AS ENUM ('owner', 'admin', 'editor', 'viewer');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_member_roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_member_id" UUID NOT NULL,
    "role" "team_role" NOT NULL,

    CONSTRAINT "team_member_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "sid" VARCHAR NOT NULL,
    "sess" JSON NOT NULL,
    "expire" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_unique" ON "users"("email");

-- CreateIndex
CREATE INDEX "idx_users_email" ON "users"("email");

-- CreateIndex
CREATE INDEX "idx_team_members_team_id" ON "team_members"("team_id");

-- CreateIndex
CREATE INDEX "idx_team_members_user_id" ON "team_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_team_members_user_team" ON "team_members"("user_id", "team_id");

-- CreateIndex
CREATE INDEX "idx_team_member_roles_member_id" ON "team_member_roles"("team_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_team_member_roles_member_role" ON "team_member_roles"("team_member_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_unique" ON "api_keys"("key");

-- CreateIndex
CREATE INDEX "idx_api_keys_user_team" ON "api_keys"("user_id", "team_id");

-- CreateIndex
CREATE INDEX "idx_api_keys_key_active" ON "api_keys"("key");

-- CreateIndex
CREATE INDEX "IDX_session_expire" ON "session"("expire");

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "team_member_roles" ADD CONSTRAINT "team_member_roles_team_member_id_team_members_id_fk" FOREIGN KEY ("team_member_id") REFERENCES "team_members"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

