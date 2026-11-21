# deepseek-bridge

A local OpenAI-compatible HTTP API that drives the real DeepSeek web UI in
a hidden browser window. No API key. No credit top-ups. Just your DeepSeek
account and an Electron window.

Exposes `127.0.0.1:11435/v1` so any OpenAI-compatible client (OpenCode, or
any tool that speaks `/v1/chat/completions`) can use DeepSeek for free, with
full tool-call support and DeepThink reasoning.

Claude Code speaks Anthropic's `/v1/messages` API, not OpenAI's, so it needs
a translating proxy (e.g. claude-code-router or LiteLLM) in between.

## Why this exists

DeepSeek's API costs money. The web UI is free. This bridge
types your prompts into the actual chat.deepseek.com page, clicks submit,
reads the streaming response from the page's own XHR calls, and shapes it
back into standard OpenAI SSE format. From your coding agent's perspective,
it looks exactly like an OpenAI endpoint.

DeepThink mode is auto-enabled. Search mode is auto-disabled. Thinking
content streams to OpenCode's reasoning panel. Tool calls loop back through
the same conversation thread so the model sees its own output, just like a
real user session.

## Disclaimer

This project is not affiliated with, endorsed by, or sponsored by DeepSeek
(Hangzhou DeepSeek Artificial Intelligence Co., Ltd.) or any of its
affiliates. The name "DeepSeek" is used solely to describe the service this
tool interoperates with.

This software does not:

- Distribute, repackage, or redistribute any DeepSeek intellectual property
- Bypass any authentication, paywall, or access control mechanism
- Modify, reverse-engineer, or tamper with DeepSeek's backend services
- Scrape, crawl, or extract data from DeepSeek beyond what a user manually
  typing into the website would receive

It is a browser automation tool. It opens a real browser window to
chat.deepseek.com and types prompts on your behalf, exactly as you would
manually. You must use your own DeepSeek account and comply with DeepSeek's
Terms of Service. You are responsible for how you use this tool.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

This project depends on the chat.deepseek.com web interface, which DeepSeek
may change, restrict, or discontinue at any time without notice. There is no
guarantee this bridge will continue to work. Rate limits, bot detection, or
other restrictions could be introduced at any point. This is a best-effort
tool maintained by the community — use it while it works, but don't build
critical infrastructure on it.

## What you get

- Free DeepSeek access through the web UI (no API key required)
- Full streaming support with proper SSE delta chunks
- DeepThink reasoning content piped to `reasoning_content` in the delta
- Tool-call loop with any tools the client declares (the tool list is typed
  into the prompt, since the web UI has no tools field)
- Parses `<tool_call>` JSON, `<bash>cmd</bash>`-style tags, and DeepSeek's
  native DSML format, including the mangled variants it produces in long
  sessions; asks DeepSeek to re-send a call that can't be parsed
- Catches bare shell commands when the model forgets tags
- One DeepSeek chat per client conversation, remembered across restarts
- Auto-enables DeepThink, auto-disables Search on every prompt
- System tray icon, hides to background, reuses login session

## Quick start

```bash
git clone https://github.com/kusoidev/deepseek-bridge.git
cd deepseek-bridge
npm install
npm run build
npm start
```

A DeepSeek window opens. Log in once; when the chat box appears, the window
hides itself to the tray and the bridge runs in the background. Check it's
ready:

```bash
curl http://127.0.0.1:11435/health   # {"status":"ready","queue":0}
```

`"loading"` means the page isn't usable yet: look at the window for a login
page, captcha or error.

**Stopping:** Ctrl+C in the terminal that started it. Closing the window
only hides it to the tray.

**Debugging:** `BRIDGE_DEBUG=1` logs every line of DeepSeek's stream and the
page's API calls to the terminal:

```bash
npm run build && BRIDGE_DEBUG=1 npx electron .
```

## Tested with

**[OpenCode](https://github.com/anthropics/opencode)** on macOS (Apple
Silicon), and OpenCode 1.19 on Linux (WSL2, with WSLg showing the window).
Other OpenAI-compatible clients should work. If you test one and it does (or
doesn't), open an issue.

## Setup for OpenCode

Add to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "provider": {
    "deepseek": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "DeepSeek (local bridge)",
      "options": { "baseURL": "http://127.0.0.1:11435/v1" },
      "models": {
        "deepseek-chat": {
          "max_tokens": 8192,
          "context_length": 65536
        }
      }
    }
  },
  "model": "deepseek/deepseek-chat"
}
```

No API key needed. OpenCode sends one anyway; the bridge ignores it.

The `"model"` line makes DeepSeek the default. Without it, pick it per
session with `/models` inside OpenCode or `opencode -m deepseek/deepseek-chat`
(`-m` takes `provider/model`, using the names in this config).

OpenCode also reads Claude Code instruction files, including your global
`~/.claude/CLAUDE.md`. If those don't suit DeepSeek, start OpenCode with
`OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1` (skips the global file) or
`OPENCODE_DISABLE_CLAUDE_CODE=1` (skips all of them).

## How it works

```
POST /v1/chat/completions  -->  Express queue (serial, one at a time)
                                          |
                                   Electron BrowserWindow
                                   (chat.deepseek.com, hidden)
                                          |
                                   Preload types prompt, clicks Enter
                                   Patches XMLHttpRequest to intercept
                                   DeepSeek's streaming SSE response
                                          |
                                   Extracts text + thinking tokens
                                   Sends chunks back via IPC
                                          |
                                   Main process shapes into OpenAI
                                   SSE format (delta.content,
                                   reasoning_content, tool_calls)
                                          |
You  <--  SSE stream  <--  finish_reason: stop | tool_calls | error
```

## Features

### DeepThink support

DeepThink mode is enabled automatically when the bridge starts and before
every prompt. Thinking text streams to `delta.reasoning_content`, which
OpenCode renders in its thinking panel. Response text goes to
`delta.content`. They never mix.

### Tool calls

The web UI has no tools field, so on user turns the bridge types the
request's `tools` (names, descriptions, JSON Schema parameters) into the
prompt and asks for calls in this format:

```xml
<tool_call>{"name": "bash", "arguments": {"command": "ls -la"}}</tool_call>
```

DeepSeek often answers in its own native format instead:

```
<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read">
<｜｜DSML｜｜ parameter name="filePath" string="true">calc.py</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>
```

That is parsed too, tolerantly: in long sessions DeepSeek drops `invoke`
tags, uses single bars, leaves closers unnamed, or gets cut off mid-tag.
Every DSML-looking tag is treated as a marker; a call without a tool name
gets one from its argument names when exactly one declared tool fits. The
older `<bash>cmd</bash>` tags still work.

If a reply contains tool-call markup but nothing in it parses, the bridge
doesn't pass the broken text on: it asks DeepSeek once, in the same chat,
to re-send the call in `<tool_call>` format.

Tool results are fed back into the same chat with randomized delays (4-7
seconds, never repeating) so follow-up turns look natural.

### Conversations

Each client conversation gets its own DeepSeek chat. A conversation is
identified by its first user message plus its first reply, and its chat
URL is saved to `chat-map.json` in Electron's userData folder
(`~/.config/deepseek-bridge/` on Linux; hashes only, no prompt text), so
resumed sessions find their chat after a restart. A conversation the bridge
has no chat for (e.g. one started on another model) is typed into a new
chat as a transcript. Title-generation side requests get throwaway chats.

The system prompt and tool list are re-typed only when they change, since
the web chat can only append, never replace.

### Reliability

- If DeepSeek hasn't started replying 15s after a prompt is typed, Enter is
  pressed again; after another 15s the request fails with an error instead
  of hanging, and the next request reloads the chat.
- If the client disconnects (e.g. you interrupt OpenCode), the bridge
  aborts DeepSeek's reply and frees the queue, so a retry runs at once.
- Failed chat page loads (e.g. network blips) are retried.

### Bare command fallback

If the model outputs a single-line command without any tool tags, the bridge
detects it and wraps it as a bash tool call automatically. Covers cases
where the model forgets the XML wrapper.

### Tool allowlist

Only recognized tool names are parsed. HTML tags and markdown angle brackets
are left in the prose untouched. Request-level tool filtering via the
OpenAI `tools` array is supported.

## Endpoints

| Method | Path                    | Description                              |
|--------|-------------------------|------------------------------------------|
| GET    | `/health`               | Status + queue length                    |
| GET    | `/v1/models`            | Returns `deepseek-chat` model            |
| POST   | `/v1/chat/completions`  | Chat completions (streaming + non-streaming) |

## Building

```bash
npm run build
```

Two TypeScript compilations:

- **Main** (`tsconfig.main.json`) — Node.js, no DOM. App, DeepSeek, Server, Shared, Scripts.
- **Preload** (`tsconfig.preload.json`) — Renderer with DOM. Preload, Shared.

Output lands in `dist/` (gitignored). Entry point: `dist/Main/App/Main.js`.

## Source layout

```
src/
  Main/
    App/                Lifecycle + shared state
      Main.ts             Entry point
      State.ts            All mutable state in one object
      Constants.ts        Port, URLs, tool allowlist
      TrayManager.ts      System tray icon and menu
    DeepSeek/           Model interaction
      DeepSeekWindow.ts   BrowserWindow + IPC handlers
      ChatRouter.ts       Conversation -> DeepSeek chat routing
      PromptBuilder.ts    OpenAI messages to prompt string
      StreamHandler.ts    SSE writing, flush, finish, tool-call repair
      ToolParser.ts       tool_call, XML-tag and DSML parsing
    Server/             HTTP-facing
      ApiServer.ts        Express routes
      RequestQueue.ts     Serialized queue with delays
  Preload/             Renderer preload (nodeIntegration: true)
    PreloadEntry.ts       Entry point
    DeepSeekUi.ts         Textarea typing, Enter submit, toggles
    XhrPatch.ts           XMLHttpRequest monkey-patch
  Shared/              Shared between main and preload
    Types.ts              All interfaces
  Scripts/             Standalone utilities
    GenCerts.ts           RSA certificate generator (optional)
```

## Requirements

- Node.js 20+
- npm
- A DeepSeek account

## Limitations

- One request at a time — the queue is strictly serial
- Tool calls depend on DeepSeek following a text format; long sessions make
  its output sloppier, and a call that is still broken after one repair
  attempt reaches the client as text
- Two conversations with the same first message and an identical first
  text reply can't be told apart
- Tested on macOS (Apple Silicon) and Linux (WSL2); Windows is not verified

## License

MIT — see [LICENSE](./LICENSE) for full text.

This project is a browser automation tool. It is not a derivative work of
DeepSeek. It does not contain, bundle, or redistribute any DeepSeek code,
assets, or proprietary materials. The browser window it controls connects
to the publicly accessible chat.deepseek.com website using the user's own
credentials, exactly as a human would.