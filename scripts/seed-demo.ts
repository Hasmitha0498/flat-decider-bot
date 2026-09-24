// DEMO ONLY: npm run demo:seed -- [your Telegram user id]
// With your Telegram id you play Riya and can run /compare from your own Telegram.
// Without it, the group is created with the join code printed below (for inspection in Supabase).
import { seedDemo } from '../src/demo/seedDemo';

async function main() {
  const telegramId = process.argv[2] ? Number(process.argv[2]) : null;
  if (telegramId !== null && !Number.isInteger(telegramId)) {
    console.error('Usage: npm run demo:seed -- [telegram_user_id]');
    process.exit(1);
  }
  const group = await seedDemo(telegramId);
  console.log(`Demo group created: ${group.name} (join code ${group.join_code})`);
  if (telegramId) console.log('Open your bot in Telegram and send /status, then /compare.');
  console.log('Remove demo data later with supabase/remove_demo_data.sql');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
