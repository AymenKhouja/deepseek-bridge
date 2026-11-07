import { IpcRenderer } from 'electron';
import { DeepSeekFragment, Extracted, FragmentTracker } from './FragmentTracker';

/** OpenAI-compatible delta via choices[0].delta.content. */
interface DeepSeekDeltaPayload {
  choices?: Array<{
    delta?: { content?: string; role?: string; reasoning_content?: string };
    finish_reason?: string | null;
  }>;
}

/** APPEND operation carrying fragments (p='fragments', o='APPEND'). */
interface DeepSeekAppendPayload {
  p: string;
  o: 'APPEND';
  v: DeepSeekFragment[];
}

/** Nested response object inside a { v: { response: ... } } payload. */
interface DeepSeekResponseNested {
  response?: {
    fragments?: DeepSeekFragment[];
    has_pending_fragment?: boolean;
  };
}

/** Top-level payload wrapping a response nested object. */
interface DeepSeekResponsePayload {
  v: DeepSeekResponseNested;
}

/** A single operation inside a BATCH array. */
interface DeepSeekBatchOp {
  o: string;
  p: string;
  v?: DeepSeekFragment[] | DeepSeekBatchOp[];
}

/**
 * Union of all possible SSE data shapes emitted by DeepSeek's streaming
 * endpoint. Used as the target type for JSON.parse() in the XHR patch.
 */
type DeepSeekSSEPayload =
  | DeepSeekDeltaPayload
  | DeepSeekAppendPayload
  | { v: string }
  | DeepSeekResponsePayload
  | { v: DeepSeekBatchOp[] };

/**
 * Monkey-patch window.XMLHttpRequest to intercept DeepSeek's streaming
 * chat completion endpoint (/api/v0/chat/completion) and relay response
 * and thinking tokens to the main process over IPC as separate streams.
 *
 * This runs in the renderer process with nodeIntegration: true and
 * contextIsolation: false, so it has direct access to Node APIs and
 * Electron's ipcRenderer.
 *
 * Two content streams are extracted from the response and sent as
 * separate IPC messages:
 * - RESPONSE fragments become bridge:chunk.
 * - THINK/THINKING fragments become bridge:thinking.
 *
 * A FragmentTracker keeps the reply's fragment list so that untyped
 * appended text is routed correctly and a list DeepSeek sends again in
 * full passes on only its new text. SSE-level
 * event types (like 'thinking' events) are also tracked and used to
 * disambiguate direct string payloads.
 *
 * A per-request line buffer accumulates partial SSE frames across
 * progress events so data straddling a chunk boundary is never dropped.
 *
 * @param ipc - Electron IPC renderer for sending chunks to main process.
 *
 * @example
 * InstallXhrPatch(ipcRenderer);
 */
/** Number of the latest chat stream, sent with its events so the main process can ignore older ones. */
let xhrSeq = 0;

/** The latest chat stream, so it can be aborted when the client gives up. */
let activeXhr: XMLHttpRequest | null = null;

/**
 * Abort DeepSeek's reply in progress (the client disconnected).
 * Aborting fires neither 'load' nor 'error', so no bridge:done is sent.
 */
export function AbortActiveChat(): void {
  if (!activeXhr) return;
  console.log('[xhr-patch] aborting reply in progress');
  activeXhr.abort();
  activeXhr = null;
}

export function InstallXhrPatch(ipc: IpcRenderer): void {
  const OrigXHR = (window as unknown as Record<string, unknown>).XMLHttpRequest as typeof XMLHttpRequest;

  (window as unknown as Record<string, unknown>).XMLHttpRequest = function PatchedXHR(): XMLHttpRequest {
    const xhr = new OrigXHR();
    let isChat = false;
    let lastOffset = 0;
    let lineBuf = '';
    let frags = new FragmentTracker();
    let currentEvent = '';
    let listenerAdded = false;
    const origOpen = xhr.open.bind(xhr);
    const origSend = xhr.send.bind(xhr);

    xhr.open = function (
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ): void {
      isChat = typeof url === 'string' && url.includes('/api/v0/chat/completion');
      if (isChat) console.log('[xhr-patch] open:', url.toString().slice(0, 80));
      return origOpen(method, url, async ?? true, username ?? null, password ?? null);
    };

    xhr.send = function (body?: Document | XMLHttpRequestBodyInit | null): void {
      if (!isChat) { origSend(body); return; }
      if (listenerAdded) {
        console.warn('[xhr-patch] send called again on same xhr, skipping listener re-add');
        origSend(body);
        return;
      }
      listenerAdded = true;
      lastOffset = 0;
      lineBuf = '';
      frags = new FragmentTracker();
      currentEvent = '';
      console.log('[xhr-patch] send on chat URL, adding listeners');
      const seq = ++xhrSeq;
      activeXhr = xhr;
      ipc.send('bridge:started', seq);

      xhr.addEventListener('progress', () => {
        const raw = xhr.responseText || '';
        const chunk = raw.slice(lastOffset);
        lastOffset = raw.length;
        if (!chunk) return;

        const lines = chunk.split('\n');
        for (const line of lines) {
          const t = line.trim();
          if (!t) { currentEvent = ''; continue; }
          if (t.startsWith('event: ')) { currentEvent = t.slice(7).trim(); continue; }
          if (!t.startsWith('data: ')) continue;
          const payload = t.slice(6);
          if (payload.trim() === '[DONE]' || payload.trim() === 'FINISHED' || currentEvent === 'message_stop') continue;

          try {
            const parsed = JSON.parse(payload) as DeepSeekSSEPayload;
            const out: Extracted = { thinking: '', content: '' };
            let note = '';

            const delta = (parsed as DeepSeekDeltaPayload).choices?.[0]?.delta;
            if (delta) {
              if (typeof delta.reasoning_content === 'string') out.thinking += delta.reasoning_content;
              if (typeof delta.content === 'string') out.content += delta.content;
            } else if ('p' in parsed && typeof parsed.p === 'string' && parsed.p.includes('fragments')) {
              if (Array.isArray(parsed.v)) {
                if (parsed.o === 'APPEND') frags.Add(parsed.v as DeepSeekFragment[], out);
                // The whole list sent again (no `o`, or SET) in place of the old one.
                else if (/fragments$/.test(parsed.p)) {
                  const mismatched = frags.Replace(parsed.v as DeepSeekFragment[], out);
                  note = `replaced fragment list, ${mismatched} mismatched|`;
                }
              } else if (typeof parsed.v === 'string' && parsed.v) {
                frags.Append(parsed.v, out);
              }
            } else if ('v' in parsed && typeof parsed.v === 'string' && parsed.v && parsed.v !== 'FINISHED') {
              const unescaped = parsed.v.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r');
              frags.Append(unescaped, out, currentEvent === 'thinking' ? 'THINK' : frags.active);
            } else if ('v' in parsed && typeof parsed.v === 'object' && parsed.v !== null && !Array.isArray(parsed.v)) {
              const resp = (parsed.v as DeepSeekResponseNested).response;
              if (resp && !resp.has_pending_fragment) frags.Replace(resp.fragments ?? [], out);
            } else if ('v' in parsed && Array.isArray(parsed.v)) {
              for (const op of parsed.v as DeepSeekBatchOp[]) {
                if (op.p !== 'fragments' || op.o !== 'BATCH') continue;
                const nestedOps = op.v as DeepSeekBatchOp[] | undefined;
                if (!nestedOps) continue;
                for (const bop of nestedOps) {
                  if (bop.o !== 'APPEND') continue;
                  if (Array.isArray(bop.v)) frags.Add(bop.v as DeepSeekFragment[], out);
                }
              }
            }

            if (out.thinking) ipc.send('bridge:thinking', out.thinking, seq);
            if (out.content) ipc.send('bridge:chunk', out.content, seq);
            if (process.env.BRIDGE_DEBUG) ipc.send('bridge:debug', `${currentEvent}|${frags.active}|c=${out.content.length}|t=${out.thinking.length}|${note}${payload.slice(0, 2000)}`);
          } catch (_) { }
        }
      });

      xhr.addEventListener('load', () => {
        console.log('[xhr-patch] load, sending bridge:done');
        if (activeXhr === xhr) activeXhr = null;
        ipc.send('bridge:done', seq);
      });

      xhr.addEventListener('error', () => {
        if (activeXhr === xhr) activeXhr = null;
        ipc.send('bridge:done', seq);
      });

      origSend(body);
    };

    return xhr;
  };

  const PatchedXHR = (window as unknown as Record<string, unknown>).XMLHttpRequest as Record<string, unknown>;
  PatchedXHR.prototype = OrigXHR.prototype;
  PatchedXHR.UNSENT = OrigXHR.UNSENT;
  PatchedXHR.OPENED = OrigXHR.OPENED;
  PatchedXHR.HEADERS_RECEIVED = OrigXHR.HEADERS_RECEIVED;
  PatchedXHR.LOADING = OrigXHR.LOADING;
  PatchedXHR.DONE = OrigXHR.DONE;

  console.log('[preload] XHR patch installed');
}