-- AlterTable
ALTER TABLE "users" ADD COLUMN     "marketing_consent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "terms_accepted_at" TIMESTAMPTZ(6);
