import { ParsedContent, ParsedToolCall } from '../../Shared/Types';
import { TOOL_NAMES } from '../App/Constants';

/**
 * Build a function arguments object from a raw tool name and its inner text content.
 *
 * Tries JSON parsing first (so `{"command": "ls -la", "description": "List files"}`
 * works directly). Falls back to per-tool defaults: `bash` commands go to `{command}`,
 * `read` takes the first line as `filePath`, `write` splits first line into `filePath`
 * and the rest into `content`, etc.
 *
 * @param name - Lowercased tool name (e.g., 'bash', 'read', 'write').
 * @param content - Raw text between the XML tags.
 * @returns A flat object mapping argument names to their string values.
 *
 * @example
 * // From <bash>ls -la</bash>
 * BuildArgs('bash', 'ls -la')
 * // => { command: 'ls -la', description: 'Run command' }
 *
 * @example
 * // From <read>/path/to/file.js</read>
 * BuildArgs('read', '/path/to/file.js')
 * // => { filePath: '/path/to/file.js' }
 */
function BuildArgs(name: string, content: string): Record<string, string> {
  const trimmed = content.trim();
  if (trimmed[0] === '{') {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch (_) { }
  }
  const lines = content.split('\n');
  const first = lines[0].trim();
  const rest = lines.slice(1).join('\n');
  switch (name) {
    case 'bash': case 'shell': case 'sh': case 'run':
      return { command: trimmed, description: 'Run command' };
    case 'read':
      return { filePath: first };
    case 'write':
      return { filePath: first, content: rest };
    case 'edit': case 'multiedit': case 'apply_patch': case 'patch':
      return { filePath: first, content: trimmed };
    case 'grep':
      return { pattern: first };
    case 'glob':
      return { pattern: first };
    case 'list': case 'ls':
      return { path: first || '.' };
    case 'webfetch': case 'web_fetch': case 'fetch':
      return { url: first };
    case 'websearch': case 'web_search':
      return { query: trimmed };
    default:
      return { input: trimmed };
  }
}

/**
 * Check whether a tool name is permitted in the current context.
 *
 * If the request specified a tools array, only names in that set pass.
 * Otherwise, the global TOOL_NAMES allowlist is used. This prevents stray
 * HTML tags (like `<div>`, `<span>`) from being misparsed as tool calls.
 *
 * @param name - Lowercased tool name to check.
 * @param allowedSet - Request-level allowed tool names, or null for global allowlist.
 * @returns true if the tool is allowed.
 *
 * @example
 * IsToolName('bash', null)
 * // => true  (in global allowlist)
 *
 * @example
 * IsToolName('div', new Set(['bash', 'read']))
 * // => false  (not in request-level set)
 */
export function IsToolName(name: string, allowedSet: Set<string> | null): boolean {
  if (allowedSet && allowedSet.size > 0) return allowedSet.has(name);
  return name in TOOL_NAMES;
}

/** `｜｜DSML｜｜ ` prefix inside DeepSeek's native tool-call tags (U+FF5C bars; ASCII `|` tolerated). */
const DSML = '[｜|]+\\s*DSML\\s*[｜|]+\\s*';
const DSML_INVOKE_RE = new RegExp(`<${DSML}invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)</${DSML}invoke>`, 'g');
const DSML_PARAM_RE = new RegExp(`<${DSML}parameter\\s+name="([^"]+)"(?:\\s+string="(true|false)")?\\s*>([\\s\\S]*?)</${DSML}parameter>`, 'g');
const DSML_WRAPPER_RE = new RegExp(`</?${DSML}(?:function_)?calls>`, 'g');

/**
 * Parse DeepSeek's native DSML tool-call blocks from the model's response text.
 *
 * Even when told to use `<tool_call>`, DeepSeek sometimes falls back to the
 * format it was trained on (OpenCode's prompt triggers it on the first turn):
 *
 *   <｜｜DSML｜｜ calls>
 *   <｜｜DSML｜｜ invoke name="read">
 *   <｜｜DSML｜｜ parameter name="filePath" string="true">calc.py</｜｜DSML｜｜ parameter>
 *   </｜｜DSML｜｜ invoke>
 *   </｜｜DSML｜｜ calls>
 *
 * `string="true"` values are taken verbatim; `string="false"` values are JSON
 * (numbers, booleans, objects). A lone `arguments` parameter holding a JSON
 * object is unwrapped, since DeepSeek also emits that shape.
 *
 * @param text - The full accumulated response text from the model.
 * @param allowedSet - Request-level allowed tool names, or null.
 * @param firstIndex - Index to give the first call (after any XML-tag calls).
 * @returns The parsed tool calls and the raw invoke blocks they came from.
 */
function ParseDsmlCalls(text: string, allowedSet: Set<string> | null, firstIndex: number): { toolCalls: ParsedToolCall[]; matched: string[] } {
  const toolCalls: ParsedToolCall[] = [];
  const matched: string[] = [];
  let id = firstIndex;
  let m: RegExpExecArray | null;
  DSML_INVOKE_RE.lastIndex = 0;
  while ((m = DSML_INVOKE_RE.exec(text)) !== null) {
    const fnName = m[1].toLowerCase();
    if (!IsToolName(fnName, allowedSet)) continue;
    let fnArgs: Record<string, unknown> = {};
    let p: RegExpExecArray | null;
    DSML_PARAM_RE.lastIndex = 0;
    while ((p = DSML_PARAM_RE.exec(m[2])) !== null) {
      let value: unknown = p[3];
      if (p[2] === 'false') {
        try { value = JSON.parse(p[3]); } catch (_) { }
      }
      fnArgs[p[1]] = value;
    }
    const keys = Object.keys(fnArgs);
    if (keys.length === 1 && keys[0] === 'arguments') {
      let inner = fnArgs.arguments;
      if (typeof inner === 'string') {
        try { inner = JSON.parse(inner); } catch (_) { }
      }
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) fnArgs = inner as Record<string, unknown>;
    }
    toolCalls.push({
      index: id,
      id: `call_${Date.now()}_${id}`,
      type: 'function',
      function: { name: fnName, arguments: JSON.stringify(fnArgs) },
    });
    matched.push(m[0]);
    id++;
  }
  return { toolCalls, matched };
}

/**
 * Parse XML-style tool call tags from the model's full response text.
 *
 * Matches patterns like `<bash>ls -la</bash>` and `<read>file.js</read>`,
 * extracts each into a ParsedToolCall with a unique ID, and returns the
 * cleaned prose with all tags removed.
 *
 * Only tool names that pass IsToolName are included; unmatched tags are
 * left in the cleaned content (they're assumed to be markdown or code).
 *
 * The `<tool_call>` tag supports three JSON shapes DeepSeek may emit:
 * - `{"type": "bash", "command": "..."}`  (type field)
 * - `{"name": "bash", "command": "..."}`  (name field)
 * - `{"type": "bash", "arguments": {"command": "..."}}`  (nested arguments)
 *
 * DeepSeek's native DSML blocks are parsed too (see ParseDsmlCalls).
 *
 * @param text - The full accumulated response text from the model.
 * @param allowedSet - Request-level allowed tool names, or null.
 * @returns Object with the parsed tool calls and the cleaned text.
 *
 * @example
 * ParseToolCalls('Sure! <bash>ls</bash> done.', null)
 * // => {
 * //   toolCalls: [{ index: 0, id: 'call_1712345678_0', type: 'function',
 * //                 function: { name: 'bash', arguments: '{"command":"ls",...}' } }],
 * //   content: 'Sure! done.'
 * // }
 */
export function ParseToolCalls(text: string, allowedSet: Set<string> | null): ParsedContent {
  const toolCalls: ParsedToolCall[] = [];
  let id = 0;
  const re = /<(\w+)>([\s\S]*?)<\/\1>/g;
  const matched: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tagName = m[1].toLowerCase();
    const innerText = m[2].trim();
    let fnName: string;
    let fnArgs: Record<string, string>;
    let callId: string;

    if (tagName === 'tool_call') {
      const parsed = JSON.parse(innerText);
      fnName = (parsed.type || parsed.name || '').toLowerCase();
      if (!fnName || !IsToolName(fnName, allowedSet)) continue;
      callId = parsed.id || `call_${Date.now()}_${id}`;
      if (parsed.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments)) {
        fnArgs = { ...parsed.arguments };
      } else {
        fnArgs = { ...parsed };
        delete fnArgs.type;
        delete fnArgs.name;
        delete fnArgs.id;
        delete fnArgs.arguments;
      }
    } else {
      if (!IsToolName(tagName, allowedSet)) continue;
      fnName = tagName;
      callId = `call_${Date.now()}_${id}`;
      fnArgs = BuildArgs(tagName, innerText);
    }

    toolCalls.push({
      index: id,
      id: callId,
      type: 'function',
      function: { name: fnName, arguments: JSON.stringify(fnArgs) },
    });
    matched.push(m[0]);
    id++;
  }
  const dsml = ParseDsmlCalls(text, allowedSet, id);
  toolCalls.push(...dsml.toolCalls);
  matched.push(...dsml.matched);
  let cleaned = text;
  for (const match of matched) {
    cleaned = cleaned.split(match).join('');
  }
  if (dsml.toolCalls.length > 0) cleaned = cleaned.replace(DSML_WRAPPER_RE, '');
  cleaned = cleaned.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { toolCalls, content: cleaned };
}