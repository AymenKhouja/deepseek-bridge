import { BrowserWindow, Tray } from 'electron';
import { QueuedRequest, StreamSink } from '../../Shared/Types';

/**
 * Central mutable state object for the bridge main process.
 *
 * All modules import and mutate this single object directly — there are no
 * setters, getters, or event emitters. This keeps the data flow transparent:
 * you can trace any state change to a direct assignment.
 *
 * Fields are grouped by subsystem:
 * - Queue/request: pendingRequest, requestQueue, requestIdSeq
 * - Window: deepseekWindow, deepseekReady, tray
 * - Stream: currentStreamRes, streamBuffer, streamTimer, streamDone,
 *           responseInProgress, fullResponseText, emittedContent, firstDelta
 * - Tools: currentAllowedTools, lastToolDelay
 * - Chats: currentChatKey, currentKeyBase, currentContextHash
 */
export const State = {
  /** The request currently being processed, or null if idle. */
  pendingRequest: null as QueuedRequest | null,

  /** FIFO queue of requests waiting for the DeepSeek window to be free. */
  requestQueue: [] as QueuedRequest[],

  /** Monotonically incrementing counter for request IDs. */
  requestIdSeq: 0,

  /** The hidden Electron BrowserWindow running chat.deepseek.com. */
  deepseekWindow: null as BrowserWindow | null,

  /** Whether the DeepSeek chat UI has been detected and is ready for input. */
  deepseekReady: false,

  /** The HTTP response sink for the currently active streaming request. */
  currentStreamRes: null as StreamSink | null,

  /** Buffer of unreleased text from the model that hasn't been flushed yet. */
  streamBuffer: '',

  /** 50ms interval timer that periodically flushes the stream buffer. */
  streamTimer: null as ReturnType<typeof setInterval> | null,

  /** Whether the current stream has been finalized (stop, error, or tool_calls). */
  streamDone: false,

  /** Whether DeepSeek started a reply stream for the in-flight prompt (see the submit watchdog in RequestQueue). */
  streamStarted: false,

  /** Number of the reply stream belonging to the in-flight request; events from other streams (e.g. an aborted one) are ignored. -1 until it starts. */
  activeXhrSeq: -1,

  /** Whether a response is actively being streamed to the client. */
  responseInProgress: false,

  /** Complete accumulated text from the model for the current request. */
  fullResponseText: '',

  /** Total text content already emitted as delta chunks to the client. */
  emittedContent: '',

  /** Whether the next delta chunk should include the 'role' field. */
  firstDelta: true,

  /** Set of tool names allowed by the current request's tools array. */
  currentAllowedTools: null as Set<string> | null,

  /** System tray icon reference. */
  tray: null as Tray | null,

  /** The last tool-result delay used, so the next one won't repeat. */
  lastToolDelay: 0,

  /** Conversation key of the in-flight request, so its chat URL can be saved when it finishes. Null for new conversations. */
  currentChatKey: null as string | null,

  /** First user message of the in-flight request (null for one-off requests), to key a new conversation once its first reply is known. */
  currentKeyBase: null as string | null,

  /** Hash of the context the in-flight user turn leaves in its chat, or null for tool-result turns. */
  currentContextHash: null as string | null,

  /** Reload the next chat even if the window already shows it (set after DeepSeek ignored a prompt). */
  forceReload: false,
};