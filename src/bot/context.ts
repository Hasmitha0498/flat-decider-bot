import type { Member } from '../types';
import type { TelegramUser } from './telegram';

/** Who we are talking to. The bot runs in private chats, so chatId is the user's own chat. */
export interface Ctx {
  chatId: number;
  user: TelegramUser;
  member: Member | null;
}

export function displayName(user: TelegramUser): string {
  return (user.first_name || user.username || 'Friend').slice(0, 40);
}
