import { OpenAiToolDef, ParsedContent, ParsedToolCall } from '../../Shared/Types';
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
const DSML_PARAM_LENIENT_RE = new RegExp(`<${DSML}parameter\\s+name="([^"]+)"(?:\\s+string="(true|false)")?\\s*>([\\s\\S]*?)</${DSML}parameter(?:>|$)`, 'g');
const DSML_INVOKE_CLOSE_RE = new RegExp(`</${DSML}invoke>`);
const DSML_INVOKE_OPEN_RE = new RegExp(`<${DSML}invoke\\s`);
const DSML_STRAY_RE = new RegExp(`</?${DSML}(?:function_)?calls>|</${DSML}invoke>`, 'g');

/**
 * Read DSML parameter tags into an arguments object.
 *
 * `string="true"` values are taken verbatim; `string="false"` values are JSON
 * (numbers, booleans, objects). A lone `arguments` parameter holding a JSON
 * object is unwrapped, since DeepSeek also emits that shape.
 *
 * @param body - Text holding the parameter tags.
 * @param re - DSML_PARAM_RE, or DSML_PARAM_LENIENT_RE to accept a cut-off final tag.
 * @returns The arguments and the raw parameter tags they came from.
 */
function DsmlArgs(body: string, re: RegExp): { args: Record<string, unknown>; raw: string[] } {
  let args: Record<string, unknown> = {};
  const raw: string[] = [];
  let p: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((p = re.exec(body)) !== null) {
    let value: unknown = p[3];
    if (p[2] === 'false') {
      try { value = JSON.parse(p[3]); } catch (_) { }
    }
    args[p[1]] = value;
    raw.push(p[0]);
  }
  const keys = Object.keys(args);
  if (keys.length === 1 && keys[0] === 'arguments') {
    let inner = args.arguments;
    if (typeof inner === 'string') {
      try { inner = JSON.parse(inner); } catch (_) { }
    }
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) args = inner as Record<string, unknown>;
  }
  return { args, raw };
}

/**
 * Work out which tool a DSML call meant when its `invoke name="..."` tag is missing.
 *
 * Picks the one request tool whose schema has every argument given and whose
 * required arguments are all present (`command` alone → `bash` for OpenCode).
 * Ambiguous or unknown → null, so the text stays text rather than guessing.
 * Without a tools list, only `command` → `bash` is assumed.
 *
 * @param argNames - Argument names the call used.
 * @param tools - Tool definitions from the request, or null.
 * @param allowedSet - Request-level allowed tool names, or null.
 * @returns The tool name, or null.
 */
function InferToolName(argNames: string[], tools: OpenAiToolDef[] | null, allowedSet: Set<string> | null): string | null {
  if (argNames.length === 0) return null;
  if (!tools || tools.length === 0) {
    return argNames.includes('command') && IsToolName('bash', allowedSet) ? 'bash' : null;
  }
  const fits = tools.filter(tool => {
    const schema = (tool.function && tool.function.parameters) || {};
    const props = Object.keys((schema.properties as Record<string, unknown>) || {});
    const required = (schema.required as string[]) || [];
    return argNames.every(a => props.includes(a)) && required.every(r => argNames.includes(r));
  });
  if (fits.length !== 1) return null;
  const name = String(fits[0].function.name).toLowerCase();
  return IsToolName(name, allowedSet) ? name : null;
}

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
 * Sometimes the `invoke name="..."` tags are missing and the stream stops
 * mid-tag; the tool is then inferred from the argument names (InferToolName).
 *
 * @param allowedSet - Request-level allowed tool names, or null.
 * @param tools - Tool definitions from the request, or null.
 * @param firstIndex - Index to give the first call (after any XML-tag calls).
 * @returns The parsed tool calls and the raw invoke blocks they came from.
 */
function ParseDsmlCalls(text: string, allowedSet: Set<string> | null, tools: OpenAiToolDef[] | null, firstIndex: number):
  { toolCalls: ParsedToolCall[]; matched: string[] } {
  const toolCalls: ParsedToolCall[] = [];
  const matched: string[] = [];
  let id = firstIndex;
  const push = (fnName: string, fnArgs: Record<string, unknown>) => {
    toolCalls.push({
      index: id,
      id: `call_${Date.now()}_${id}`,
      type: 'function',
      function: { name: fnName, arguments: JSON.stringify(fnArgs) },
    });
    id++;
  };
  let m: RegExpExecArray | null;
  DSML_INVOKE_RE.lastIndex = 0;
  while ((m = DSML_INVOKE_RE.exec(text)) !== null) {
    const fnName = m[1].toLowerCase();
    if (!IsToolName(fnName, allowedSet)) continue;
    push(fnName, DsmlArgs(m[2], DSML_PARAM_RE).args);
    matched.push(m[0]);
  }

  // Calls whose `invoke name="..."` tag never came: parameters directly in
  // the calls block, one call per `</invoke>`, the last one possibly cut off.
  let rest = text;
  for (const block of matched) rest = rest.split(block).join('');
  for (const segment of rest.split(DSML_INVOKE_CLOSE_RE)) {
    if (DSML_INVOKE_OPEN_RE.test(segment)) continue; // named but disallowed tool: never re-route it
    const { args, raw } = DsmlArgs(segment, DSML_PARAM_LENIENT_RE);
    const fnName = InferToolName(Object.keys(args), tools, allowedSet);
    if (!fnName) continue;
    push(fnName, args);
    matched.push(...raw);
  }
  return { toolCalls, matched };
}

/**
 * Read a `<tool_call>` JSON body into a function name, arguments and call ID.
 *
 * Supports the three JSON shapes DeepSeek may emit (see ParseToolCalls).
 * Returns null for malformed JSON or a tool that isn't allowed, so a bad
 * tag is left as text instead of throwing and stalling the request.
 *
 * @param json - The JSON text inside the tag.
 * @param allowedSet - Request-level allowed tool names, or null.
 * @param index - Position of this call, for its generated ID.
 * @returns The call's parts, or null.
 */
function JsonToolCall(json: string, allowedSet: Set<string> | null, index: number):
  { fnName: string; fnArgs: Record<string, string>; callId: string } | null {
  let parsed;
  try { parsed = JSON.parse(json); } catch (_) { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const fnName = String(parsed.type || parsed.name || '').toLowerCase();
  if (!fnName || !IsToolName(fnName, allowedSet)) return null;
  const callId = parsed.id || `call_${Date.now()}_${index}`;
  let fnArgs: Record<string, string>;
  if (parsed.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments)) {
    fnArgs = { ...parsed.arguments };
  } else {
    fnArgs = { ...parsed };
    delete fnArgs.type;
    delete fnArgs.name;
    delete fnArgs.id;
    delete fnArgs.arguments;
  }
  return { fnName, fnArgs, callId };
}

/**
 * Find the end of the JSON object starting at `start` (which must be `{`),
 * skipping braces inside strings.
 *
 * @returns The index just past the closing `}`, or -1 if it never closes.
 */
function JsonObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Closing tags that may trail an unclosed `<tool_call>` JSON body. */
const TRAILING_CLOSERS_RE = new RegExp(`^(?:\\s*(?:</tool_call>|</${DSML}(?:parameter|invoke|(?:function_)?calls)>))*`);

/**
 * Parse `<tool_call>` tags that never get their `</tool_call>`.
 *
 * DeepSeek sometimes starts in the requested format and finishes in its
 * native one: `<tool_call>{...}</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>`.
 * The JSON object right after the tag is the call; any DSML closers after it
 * are consumed with it.
 *
 * @param text - The full accumulated response text from the model.
 * @param alreadyMatched - Blocks the strict parser took, skipped here.
 * @param allowedSet - Request-level allowed tool names, or null.
 * @param firstIndex - Index to give the first call.
 * @returns The parsed tool calls and the raw blocks they came from.
 */
function ParseUnclosedToolCalls(text: string, alreadyMatched: string[], allowedSet: Set<string> | null, firstIndex: number):
  { toolCalls: ParsedToolCall[]; matched: string[] } {
  let rest = text;
  for (const block of alreadyMatched) rest = rest.split(block).join('');
  const toolCalls: ParsedToolCall[] = [];
  const matched: string[] = [];
  let id = firstIndex;
  let from = 0;
  let tag: number;
  while ((tag = rest.indexOf('<tool_call>', from)) !== -1) {
    from = tag + 1;
    const open = rest.indexOf('{', tag);
    if (open === -1 || rest.slice(tag + '<tool_call>'.length, open).trim()) continue;
    const end = JsonObjectEnd(rest, open);
    if (end === -1) continue;
    const call = JsonToolCall(rest.slice(open, end), allowedSet, id);
    if (!call) continue;
    const closers = TRAILING_CLOSERS_RE.exec(rest.slice(end));
    const blockEnd = end + (closers ? closers[0].length : 0);
    toolCalls.push({
      index: id,
      id: call.callId,
      type: 'function',
      function: { name: call.fnName, arguments: JSON.stringify(call.fnArgs) },
    });
    matched.push(rest.slice(tag, blockEnd));
    from = blockEnd;
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
 * DeepSeek's native DSML blocks are parsed too (see ParseDsmlCalls), as are
 * `<tool_call>` tags closed with DSML tags instead (see ParseUnclosedToolCalls).
 *
 * @param text - The full accumulated response text from the model.
 * @param allowedSet - Request-level allowed tool names, or null.
 * @param tools - Tool definitions from the request, or null (used to name DSML calls missing their tool name).
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
export function ParseToolCalls(text: string, allowedSet: Set<string> | null, tools: OpenAiToolDef[] | null = null): ParsedContent {
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
      const call = JsonToolCall(innerText, allowedSet, id);
      if (!call) continue;
      ({ fnName, fnArgs, callId } = call);
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
  const unclosed = ParseUnclosedToolCalls(text, matched, allowedSet, id);
  toolCalls.push(...unclosed.toolCalls);
  matched.push(...unclosed.matched);
  id += unclosed.toolCalls.length;
  const dsml = ParseDsmlCalls(text, allowedSet, tools, id);
  toolCalls.push(...dsml.toolCalls);
  matched.push(...dsml.matched);
  let cleaned = text;
  for (const match of matched) {
    cleaned = cleaned.split(match).join('');
  }
  if (dsml.toolCalls.length > 0 || unclosed.toolCalls.length > 0) cleaned = cleaned.replace(DSML_STRAY_RE, '');
  cleaned = cleaned.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { toolCalls, content: cleaned };
}