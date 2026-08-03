-- AlterTable
ALTER TABLE "users" ADD COLUMN     "default_team_id" UUID;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_default_team_id_teams_id_fk" FOREIGN KEY ("default_team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
