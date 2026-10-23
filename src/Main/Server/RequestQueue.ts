import { BuildDeepSeekPrompt, ContextText } from '../DeepSeek/PromptBuilder';
import { ContextAlreadySent, ContextHash, ConversationKey, KeyBase, OpenChat, TargetChatUrl } from '../DeepSeek/ChatRouter';
import { DEEPSEEK_URL } from '../App/Constants';
import { FinishStream } from '../DeepSeek/StreamHandler';
import { State } from '../App/State';

/**
 * Compute a random delay before feeding tool results back to DeepSeek.
 *
 * Returns a value between 4000-7000ms in 100ms steps, never repeating
 * the previous delay. This prevents follow-up tool turns from firing on
 * a detectable fixed cadence that might trigger rate limiting.
 *
 * @returns A delay in milliseconds.
 *
 * @example
 * NextToolDelay()
 * // => 4500 (first call)
 * NextToolDelay()
 * // => 6700 (different from previous, second call)
 */
function NextToolDelay(): number {
  let d: number;
  do {
    d = 4000 + 100 * Math.floor(Math.random() * 31);
  } while (d === State.lastToolDelay);
  State.lastToolDelay = d;
  return d;
}

/**
 * Process the next request in the queue if the bridge is idle.
 *
 * Guards against concurrent requests: only runs when deepseekReady is true,
 * no request is in flight, and no response is in progress. Dequeues one
 * request, builds the prompt, sets up SSE headers, and sends the text
 * to the DeepSeek window via IPC.
 *
 * Continuation prompts (tool results) get a randomized delay before sending.
 * Fresh/turn prompts send immediately.
 *
 * If the built prompt is empty, returns a 400 error and retries the queue.
 */
export function ProcessQueue(): void {
  if (!State.deepseekReady || State.pendingRequest) return;
  if (State.responseInProgress) return;
  if (State.requestQueue.length === 0) return;

  State.pendingRequest = State.requestQueue.shift()!;
  const { messages, res, tools } = State.pendingRequest;

  State.currentAllowedTools = null;
  if (Array.isArray(tools) && tools.length) {
    State.currentAllowedTools = new Set<string>();
    for (const tool of tools) {
      const nm = (tool.function && tool.function.name) || tool.name;
      if (nm) State.currentAllowedTools.add(String(nm).toLowerCase());
    }
  }

  const chatKey = ConversationKey(messages);
  const target = TargetChatUrl(chatKey, messages);
  const contextHash = ContextHash(ContextText(messages, tools));
  const contextSent = ContextAlreadySent(chatKey, contextHash, target);

  const built = BuildDeepSeekPrompt(messages, tools, !contextSent, target === DEEPSEEK_URL);
  if (contextSent && built.kind === 'turn') console.log('[bridge] context unchanged, typing the new message only');
  const userText = built.text;
  if (!userText) {
    if (res.status) res.status(400).json({ error: 'empty' });
    else res.end();
    State.pendingRequest = null;
    ProcessQueue();
    return;
  }

  State.currentStreamRes = res;
  State.streamBuffer = '';
  State.fullResponseText = '';
  State.emittedContent = '';
  State.firstDelta = true;
  State.streamDone = false;
  State.responseInProgress = true;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = () => {
    if (State.deepseekWindow && !State.deepseekWindow.isDestroyed()) {
      State.deepseekWindow.webContents.send('bridge:send-prompt', userText);
    }
  };
  const delay = built.kind === 'continuation' ? NextToolDelay() : 0;
  if (delay) console.log(`[bridge] tool-result delay ${delay}ms`);

  State.currentChatKey = chatKey;
  State.currentKeyBase = KeyBase(messages);
  State.currentContextHash = ['fresh', 'turn', 'replay'].includes(built.kind) ? contextHash : null;
  OpenChat(target)
    .then(() => setTimeout(send, delay))
    .catch((err: Error) => FinishStream(err.message));
}

/**
 * Add a request to the back of the queue and attempt to process.
 *
 * The queue is strictly serial (FIFO). If the bridge is idle, the
 * request starts immediately. Otherwise it waits behind existing requests.
 *
 * @param req - The queued request to enqueue.
 *
 * @example
 * EnqueueRequest({ id: 1, messages: [...], tools: null, res: expressResponse })
 * // Request starts immediately if bridge is idle, or queues behind others.
 */
export function EnqueueRequest(req: typeof State.requestQueue[0]): void {
  State.requestQueue.push(req);
  ProcessQueue();
}