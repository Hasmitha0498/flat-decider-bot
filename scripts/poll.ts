// Local development without a public URL: long-poll Telegram and feed updates to the same handler.
// Note: this removes the webhook. Run `npm run set-webhook` again afterwards to go back to Vercel.
import { handleUpdate } from '../src/bot/handleUpdate';
import { deleteWebhook, getUpdates } from '../src/bot/telegram';

async function main() {
  await deleteWebhook();
  console.log('Polling Telegram for updates. Message your bot! (Ctrl+C to stop)');
  let offset = 0;
  for (;;) {
    try {
      const updates = await getUpdates(offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (error) {
      console.error('Polling error:', error);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

main();
