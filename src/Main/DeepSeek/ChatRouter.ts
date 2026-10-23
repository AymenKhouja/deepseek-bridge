import { createHash } from 'crypto';
import { ipcMain } from 'electron';
import { OpenAiMessage } from '../../Shared/Types';
import { DEEPSEEK_URL, MAX_REMEMBERED_CHATS, NAVIGATION_TIMEOUT_MS } from '../App/Constants';
import { State } from '../App/State';
import { ContentOf } from './PromptBuilder';

/** Conversation key → DeepSeek chat URL (`.../a/chat/s/<id>`). Insertion order doubles as LRU order. */
const chatUrls = new Map<string, string>();

/**
 * Identify which client conversation a request belongs to.
 *
 * Clients resend the whole history every turn, so the first user message is
 * the same on every turn of one conversation and differs between
 * conversations. Title-generation side requests get null: they must not
 * claim (or reuse) a conversation's chat. This check is broader than
 * IsTitleGenerator: OpenCode 1.19's title prompt says "title generator" but
 * not "Generate a title", and its first user message is the same fixed
 * text for every session, so a missed title request would share one chat.
 *
 * @param messages - Full array of OpenAI messages in chronological order.
 * @returns A stable key, or null for one-off requests.
 */
export function ConversationKey(messages: OpenAiMessage[]): string | null {
  if (messages.some(msg => msg.role === 'system' && ContentOf(msg).includes('title generator'))) return null;
  const firstUser = messages.find(msg => msg.role === 'user');
  if (!firstUser) return null;
  return createHash('sha1').update(ContentOf(firstUser)).digest('hex');
}

/**
 * Decide which DeepSeek chat a request should be typed into.
 *
 * - Known conversation: its saved chat URL.
 * - New conversation (no assistant/tool turns yet) or one-off request: a new chat.
 * - Ongoing conversation the bridge never saw (e.g. after a restart): null,
 *   meaning stay in the current chat, as the bridge always did before.
 *
 * @param key - From ConversationKey.
 * @param messages - Full array of OpenAI messages in chronological order.
 * @returns The URL to load, or null to stay put.
 */
export function TargetChatUrl(key: string | null, messages: OpenAiMessage[]): string | null {
  if (key && chatUrls.has(key)) return chatUrls.get(key)!;
  const ongoing = messages.some(msg => msg.role === 'assistant' || msg.role === 'tool');
  if (key && ongoing) {
    console.log('[bridge] unknown ongoing conversation, staying in current chat');
    return null;
  }
  return DEEPSEEK_URL;
}

/**
 * Load a chat URL in the DeepSeek window and wait until the page is usable.
 *
 * Resolves on the preload's next bridge:ready (textarea found, DeepThink
 * enabled), so the prompt is never typed into a half-loaded page. Skips the
 * reload when the window already shows that chat.
 *
 * @param url - The chat URL to open.
 */
export function OpenChat(url: string): Promise<void> {
  const win = State.deepseekWindow;
  if (!win || win.isDestroyed()) return Promise.reject(new Error('DeepSeek window is gone'));
  if (url !== DEEPSEEK_URL && win.webContents.getURL() === url) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onReady = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      ipcMain.removeListener('bridge:ready', onReady);
      reject(new Error(`DeepSeek chat did not load within ${NAVIGATION_TIMEOUT_MS / 1000}s`));
    }, NAVIGATION_TIMEOUT_MS);
    ipcMain.once('bridge:ready', onReady);
    console.log(`[bridge] opening chat ${url}`);
    win.loadURL(url);
  });
}

/**
 * Save the chat the current request was answered in under its conversation key.
 *
 * Called when a response finishes: by then DeepSeek has moved a new chat
 * from the bare root URL to its own `/a/chat/s/<id>` URL.
 *
 * @param key - The finished request's conversation key, or null.
 */
export function RememberChat(key: string | null): void {
  const win = State.deepseekWindow;
  if (!key || !win || win.isDestroyed()) return;
  const url = win.webContents.getURL();
  if (!url.includes('/chat/s/')) return;
  chatUrls.delete(key);
  chatUrls.set(key, url);
  if (chatUrls.size > MAX_REMEMBERED_CHATS) chatUrls.delete(chatUrls.keys().next().value!);
}
