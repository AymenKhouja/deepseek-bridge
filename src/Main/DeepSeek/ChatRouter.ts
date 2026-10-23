import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { app, ipcMain } from 'electron';
import { OpenAiMessage } from '../../Shared/Types';
import {
  CHAT_MAP_FILE, DEEPSEEK_URL, MAX_REMEMBERED_CHATS,
  NAVIGATION_ATTEMPTS, NAVIGATION_RETRY_DELAY_MS, NAVIGATION_TIMEOUT_MS,
} from '../App/Constants';
import { State } from '../App/State';
import { ContentOf } from './PromptBuilder';

/**
 * Conversation key → DeepSeek chat URL (`.../a/chat/s/<id>`). Insertion order doubles as LRU order.
 * Saved to disk so conversations resumed after a restart find their chat again.
 */
let chatUrls: Map<string, string> | null = null;

/** Where the map is saved: next to the login session in Electron's userData folder. */
function ChatMapPath(): string {
  return path.join(app.getPath('userData'), CHAT_MAP_FILE);
}

/**
 * Get the conversation → chat map, loading it from disk on first use.
 * A missing or unreadable file starts an empty map.
 */
function ChatUrls(): Map<string, string> {
  if (chatUrls) return chatUrls;
  chatUrls = new Map();
  try {
    const saved = JSON.parse(fs.readFileSync(ChatMapPath(), 'utf8'));
    if (Array.isArray(saved)) {
      for (const [key, url] of saved) {
        if (typeof key === 'string' && typeof url === 'string') chatUrls.set(key, url);
      }
    }
    console.log(`[bridge] loaded ${chatUrls.size} saved chat(s)`);
  } catch (_) { }
  return chatUrls;
}

/** Write the map to disk (via a temp file, so a crash mid-write can't corrupt it). */
function SaveChatUrls(): void {
  const file = ChatMapPath();
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify([...ChatUrls()]));
    fs.renameSync(`${file}.tmp`, file);
  } catch (err) {
    console.log(`[bridge] could not save chat list: ${(err as Error).message}`);
  }
}

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
  const saved = key ? ChatUrls().get(key) : undefined;
  if (saved) return saved;
  const ongoing = messages.some(msg => msg.role === 'assistant' || msg.role === 'tool');
  const win = State.deepseekWindow;
  const current = win && !win.isDestroyed() ? win.webContents.getURL() : '';
  if (!current.startsWith(DEEPSEEK_URL)) {
    console.log(`[bridge] window is not on DeepSeek (${current || 'no page'}), reloading`);
    return DEEPSEEK_URL;
  }
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
 * A failed load (e.g. ERR_NETWORK_CHANGED when WSL's network blips) is
 * retried, up to NAVIGATION_ATTEMPTS loads in all. Otherwise the window
 * would sit on Chromium's error page and every later request would fail.
 *
 * @param url - The chat URL to open.
 */
export function OpenChat(url: string): Promise<void> {
  const win = State.deepseekWindow;
  if (!win || win.isDestroyed()) return Promise.reject(new Error('DeepSeek window is gone'));
  if (url !== DEEPSEEK_URL && win.webContents.getURL() === url) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let attempts = 1;
    const cleanup = () => {
      clearTimeout(timer);
      ipcMain.removeListener('bridge:ready', onReady);
      if (!win.isDestroyed()) win.webContents.removeListener('did-fail-load', onFail);
    };
    const onReady = () => { cleanup(); resolve(); };
    const onFail = (_e: unknown, code: number, desc: string, _url: string, isMainFrame: boolean) => {
      if (!isMainFrame || code === -3) return; // -3 = ERR_ABORTED: superseded by another navigation
      if (attempts >= NAVIGATION_ATTEMPTS) {
        cleanup();
        reject(new Error(`DeepSeek chat failed to load: ${desc}`));
        return;
      }
      attempts++;
      console.log(`[bridge] load failed (${desc}), retrying ${attempts}/${NAVIGATION_ATTEMPTS}`);
      setTimeout(() => { if (!win.isDestroyed()) win.loadURL(url); }, NAVIGATION_RETRY_DELAY_MS);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`DeepSeek chat did not load within ${NAVIGATION_TIMEOUT_MS / 1000}s`));
    }, NAVIGATION_TIMEOUT_MS);
    ipcMain.on('bridge:ready', onReady);
    win.webContents.on('did-fail-load', onFail);
    console.log(`[bridge] opening chat ${url}`);
    win.loadURL(url).catch(() => { }); // failures are handled by did-fail-load
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
  const urls = ChatUrls();
  if (urls.get(key) === url && [...urls.keys()].pop() === key) return;
  urls.delete(key);
  urls.set(key, url);
  if (urls.size > MAX_REMEMBERED_CHATS) urls.delete(urls.keys().next().value!);
  SaveChatUrls();
}
