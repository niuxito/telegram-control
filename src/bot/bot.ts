import { Bot } from 'grammy';
import { config } from '../config.js';

export function createBot(): Bot {
  return new Bot(config.BOT_TOKEN);
}
