-- AlterTable
ALTER TABLE "users" ADD COLUMN     "supabase_user_id" UUID,
ALTER COLUMN "password_hash" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "users_supabase_user_id_unique" ON "users"("supabase_user_id");

