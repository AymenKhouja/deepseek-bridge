import { OpenAiMessage, OpenAiFunctionCall, OpenAiToolDef, BuiltPrompt } from '../../Shared/Types';
import { MAX_TOOL_RESULT_BYTES } from '../App/Constants';

/**
 * Check whether a system prompt is OpenCode's session-title generator.
 *
 * Title requests are one-off side requests: their system prompt is not
 * typed into DeepSeek, and they never claim a conversation's chat.
 *
 * @param sys - System prompt text.
 * @returns true for the title-generator prompt.
 */
export function IsTitleGenerator(sys: string): boolean {
  return sys.includes('title generator') && sys.includes('Generate a title');
}

/**
 * Describe the request's tools to the model in plain text.
 *
 * The real OpenAI API shows the `tools` array to the model server-side. The
 * DeepSeek web UI has no such field, so the bridge must type the tool list
 * into the prompt itself, along with the `<tool_call>` format ParseToolCalls
 * understands. The JSON shape works for any tool name, unlike bare tags.
 *
 * @param tools - Tool definitions from the request, or null.
 * @returns The tool instructions, or '' when there are no tools.
 *
 * @example
 * FormatToolDefs([{ type: 'function', function: { name: 'get_weather', description: 'Weather for a city' } }])
 * // => 'You have access to these tools:\n\n- get_weather: Weather for a city\n...'
 */
export function FormatToolDefs(tools: OpenAiToolDef[] | null): string {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const lines: string[] = [];
  for (const tool of tools) {
    const fn = tool.function || ({} as OpenAiToolDef['function']);
    const name = fn.name || tool.name;
    if (!name) continue;
    let line = `- ${name}`;
    if (fn.description) line += `: ${fn.description}`;
    if (fn.parameters) line += `\n  Parameters (JSON Schema): ${JSON.stringify(fn.parameters)}`;
    lines.push(line);
  }
  if (lines.length === 0) return '';
  return [
    'You have access to these tools:',
    lines.join('\n'),
    'To call a tool, reply with one tag per call in exactly this format, with the arguments as a JSON object matching the schema:',
    '<tool_call>{"name": "TOOL_NAME", "arguments": {"ARG": "VALUE"}}</tool_call>',
    'After the tag, stop and wait: the tool output will be sent to you in the next message. Only call tools from this list. If no tool is needed, answer in plain text with no tags.',
  ].join('\n\n');
}

/**
 * Extract the plain text content from an OpenAI message.
 *
 * Handles string content directly, arrays of content parts (multimodal),
 * and null/undefined (returns empty string).
 *
 * @param msg - An OpenAI message object.
 * @returns The concatenated text content.
 *
 * @example
 * ContentOf({ role: 'user', content: 'hello' })
 * // => 'hello'
 *
 * @example
 * ContentOf({ role: 'user', content: [{ type: 'text', text: 'hi' }] })
 * // => 'hi'
 */
export function ContentOf(msg: OpenAiMessage): string {
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const part of c) {
      if (part && typeof part === 'object') parts.push(part.text || '');
      else if (typeof part === 'string') parts.push(part);
    }
    return parts.join('\n');
  }
  return '';
}

/**
 * Build the context typed before a user message: the system prompts (minus
 * OpenCode's title-generator prompt) followed by the tool list.
 *
 * @param messages - Full array of OpenAI messages in chronological order.
 * @param tools - Tool definitions from the request, or null.
 * @returns The context text, or '' when there is none.
 */
export function ContextText(messages: OpenAiMessage[], tools: OpenAiToolDef[] | null): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role !== 'system') continue;
    const sys = ContentOf(msg);
    if (sys && !IsTitleGenerator(sys)) parts.push(sys);
  }
  parts.push(FormatToolDefs(tools));
  return parts.filter(p => p).join('\n\n');
}

/**
 * Convert an array of OpenAI messages into a single string to type into DeepSeek.
 *
 * This is the central prompt assembly logic. It decides what to type based on
 * the role of the LAST message in the array:
 *
 * - **last = tool**: The model just called tools and we have results. Build a
 *   continuation prompt that presents each tool's output labelled with the
 *   function call that produced it. Only include results that arrived after
 *   the model's last assistant turn (the web thread already saw earlier turns).
 *   Truncate any result over MAX_TOOL_RESULT_BYTES.
 *
 * - **last = user, first request**: No assistant or tool messages exist yet.
 *   Include system prompts (except the OpenAI title-generator one) followed
 *   by the user question. The web thread is empty so we need the full context.
 *
 * - **last = user, ongoing**: The web thread already holds the conversation
 *   history. Type the current system prompts (which may have been updated
 *   by agentic IDEs like Cursor or Cline) followed by the new user question,
 *   or just the question when includeContext is false.
 *
 * - **fallback**: The last message is something unexpected (e.g., assistant
 *   with no trailing tool result). Scan backward for the most recent user
 *   message and send that.
 *
 * On user turns, the request's tool list (if any) is typed after the system
 * prompts, so the model knows which tools exist and how to call them.
 *
 * @param messages - Full array of OpenAI messages in chronological order.
 * @param tools - Tool definitions from the request, or null.
 * @param includeContext - Type the system prompts and tool list on user turns.
 *   False when this exact context is already in the DeepSeek chat (see ChatRouter).
 * @returns A BuiltPrompt with the text to type and a kind tag.
 *
 * @example
 * BuildDeepSeekPrompt([
 *   { role: 'system', content: 'You are helpful.' },
 *   { role: 'user', content: 'What is 2+2?' }
 * ])
 * // => { text: 'You are helpful.\n\nWhat is 2+2?', kind: 'fresh' }
 */
export function BuildDeepSeekPrompt(
  messages: OpenAiMessage[],
  tools: OpenAiToolDef[] | null = null,
  includeContext = true,
): BuiltPrompt {
  const lastIdx = messages.length - 1;
  const last = messages[lastIdx] || ({} as OpenAiMessage);
  const lastRole = last.role || '';

  let hasAssistant = false;
  let hasTool = false;
  for (const msg of messages) {
    if (msg.role === 'assistant') hasAssistant = true;
    if (msg.role === 'tool') hasTool = true;
  }

  if (lastRole === 'tool') {
    let lastAssistantIdx = -1;
    for (let i = lastIdx; i >= 0; i--) {
      if (messages[i].role === 'assistant') { lastAssistantIdx = i; break; }
    }
    const callInfo: Record<string, OpenAiFunctionCall> = {};
    if (lastAssistantIdx >= 0 && Array.isArray(messages[lastAssistantIdx].tool_calls)) {
      for (const tcall of messages[lastAssistantIdx].tool_calls!) {
        callInfo[tcall.id] = tcall.function;
      }
    }
    const parts = ['The tool(s) you just requested have been executed. Here is the output:'];
    for (let c = lastAssistantIdx + 1; c <= lastIdx; c++) {
      if (messages[c].role !== 'tool') continue;
      const fn = callInfo[messages[c].tool_call_id!];
      let label: string;
      if (fn) label = `${fn.name || 'tool'}(${fn.arguments || ''})`;
      else label = messages[c].name || messages[c].tool_call_id || 'tool';
      let res = ContentOf(messages[c]) || '(no output)';
      const resBytes = Buffer.byteLength(res, 'utf8');
      if (resBytes > MAX_TOOL_RESULT_BYTES) {
        res = `Tool result too large (${Math.round(resBytes / 1024)} KB, limit ${Math.round(MAX_TOOL_RESULT_BYTES / 1024)} KB), so it was not included. Read it in smaller pieces instead: target a specific file with a line range, use head or tail, grep for a pattern, or list with a limit, then continue. Do not rerun the same broad command.`;
      }
      parts.push(`Result for ${label}:\n${res}`);
    }
    parts.push('Continue now. If you need another tool, reply with its tool tag. If the task is done, answer the user in plain text with no tool tags.');
    return { text: parts.join('\n\n'), kind: 'continuation' };
  }

  if (lastRole === 'user') {
    const userText = ContentOf(last);
    const head = includeContext ? [ContextText(messages, tools)] : [];
    head.push(userText);
    const text = head.filter(p => p).join('\n\n');
    if (!hasAssistant && !hasTool) return { text, kind: 'fresh' };
    return { text, kind: 'turn' };
  }

  for (let j = lastIdx; j >= 0; j--) {
    if (messages[j].role === 'user') return { text: ContentOf(messages[j]), kind: 'fallback' };
  }
  return { text: '', kind: 'empty' };
}