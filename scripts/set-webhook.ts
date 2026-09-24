// Points Telegram at your deployed Vercel URL and registers the command menu.
// Usage: npm run set-webhook -- https://your-app.vercel.app
import { env } from '../src/config';
import { setMyCommands, setWebhook } from '../src/bot/telegram';

async function main() {
  const baseUrl = process.argv[2]?.replace(/\/$/, '');
  if (!baseUrl?.startsWith('https://')) {
    console.error('Usage: npm run set-webhook -- https://your-app.vercel.app');
    process.exit(1);
  }
  await setWebhook(`${baseUrl}/api/telegram`, env('TELEGRAM_WEBHOOK_SECRET'));
  await setMyCommands([
    { command: 'start', description: 'Create or join a house search' },
    { command: 'status', description: 'Who is ready, how many flats' },
    { command: 'add', description: 'Add a flat (listing link)' },
    { command: 'listings', description: 'Flats you added' },
    { command: 'remove', description: 'Remove one of your flats' },
    { command: 'preferences', description: 'View your preferences' },
    { command: 'edit', description: 'Change a preference' },
    { command: 'compare', description: 'Compare all flats' },
    { command: 'details', description: 'Full comparison for the last result' },
    { command: 'cancel', description: 'Stop what you are typing' },
    { command: 'leave', description: 'Leave this house search' },
  ]);
  console.log(`Webhook set to ${baseUrl}/api/telegram${env('TELEGRAM_WEBHOOK_SECRET') ? ' (with secret)' : ''}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
