import '../src/shared/env/load-root-env';
import prisma from '../src/shared/db/client';
import { mintResetLink } from '../src/auth/reset-link';
import { closeRedisConnection } from '../src/evaluations/queue/connection';

/**
 * Prints a password-reset link for one account, without sending email.
 *
 * The lockout escape hatch for a self-hosted instance: the sole administrator
 * forgets their password and `EMAIL_TRANSPORT=none`, so no reset mail can ever
 * arrive and no second admin exists to mint a link from the UI. Whoever can run
 * this already has shell access to the server and its database, so it grants
 * nothing they could not do anyway.
 *
 * Usage: `npm run reset-password -- someone@example.com`
 */
async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: npm run reset-password -- <email>');
    process.exit(1);
  }

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) {
    // Safe to be specific here, unlike the HTTP endpoint: there is no anonymous
    // caller to leak account existence to.
    console.error(`No account found for ${email}.`);
    process.exit(1);
  }

  const url = await mintResetLink(email);
  if (!url) {
    // A Google-only account is not the reason: the reset flow creates the
    // missing credential row, so this path means the link itself never arrived.
    console.error(
      `Could not mint a reset link for ${email}. The reset flow did not produce a link in time — check the API logs.`,
    );
    process.exit(1);
  }

  console.log(`\nPassword reset link for ${email}:\n\n  ${url}\n\nIt works once and expires in 60 minutes.\n`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await closeRedisConnection();
    await prisma.$disconnect();
  });
