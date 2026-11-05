# n8n-nodes-zihin

[![npm version](https://badge.fury.io/js/n8n-nodes-zihin.svg)](https://badge.fury.io/js/n8n-nodes-zihin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

n8n community nodes for **[Zihin.ai](https://www.zihin.ai)** — invoke governed AI agents that reach your company's systems (with RBAC, quotas, human approvals and audit), plus media processing (image analysis, audio transcription, document parsing).

## Nodes Included

| Node | Type | Description |
|------|------|-------------|
| **Zihin Agent** ⭐ | App Node | **Recommended.** Invoke a hosted Zihin agent (runs the full agent loop: tools, memory, governance) |
| **Zihin** | App Node | Media Processing: Image, Audio, Document |

> **Zihin Agent** is the recommended way to reach Zihin: every external request runs through an agent
> under your tenant's RBAC, quota, HITL and audit.
>
> The deprecated **Zihin Chat Model** sub-node was removed in **1.0.0**. Replace it with the **Zihin Agent** node: choose the agent, send the message, use the output — tools, quota, approvals and audit then apply.

---

## Installation

### Via n8n Community Nodes (Recommended)

1. Go to **Settings** > **Community Nodes** > **Install**
2. Search for `n8n-nodes-zihin` and install

### Via npm

```bash
npm install n8n-nodes-zihin
```

## Configuration

1. Get your API Key at [zihin.ai](https://console.zihin.ai) > **Settings** > **API Keys**
2. In n8n: **Credentials** > **Add Credential** > **Zihin API**
3. Enter your API Key (format: `zhn_live_xxx`)

---

## Zihin Agent — output

| Field | Meaning |
|---|---|
| `content` | The agent's final answer |
| `contentSource` | `response` = the final event (safe to publish). `tokens` = the stream ended early and this is the raw per-iteration text, **including the model's internal deliberation** — branch on this before sending anywhere external |
| `sessionId` | Reuse on the next call to continue the conversation |
| `blocks` | Structured cards emitted by the agent, if any |
| `usage`, `model`, `iterations`, `executionTimeMs` | Cost and timing from the backend |
| `sources` | References the agent used (now populated; used to be always empty) |
| `outcome`, `finishReason`, `truncated`, `executionId` | How the turn ended (`COMPLETED`, `LENGTH`…) and its ID for support. A turn the model provider refused (`REFUSED`), that hit the context limit, timed out or failed is an **error**, not an output item: the backend's neutral sentence is never published as the answer |
| `clientMessageId`, `idempotentReplay` | Echo of the *Client Message ID* option and `true` when the backend replayed the stored answer of an earlier call with the same ID (no `usage` then) |
| `gated` | `true` when the reply is a canned gate message (human handoff, denylist): no model ran |
| `acceptedFields`, `ignoredFields` | What the server applied from *Structured Input*. `ignoredFields` with reason `redacted` is a warning: a Context value looked like a secret and was masked |

## Zihin Agent — structured input (admin/owner API key)

| Field | Who sees it | Use it for |
|---|---|---|
| **Consumer Key** | the platform | Who the end user is (e.g. a phone number, digits only): per-person memory and controls. To continue conversations a webhook stored, use the same value |
| **Context (JSON)** | the model and the tools | Data the agent should consider, e.g. `{"customer": "Ana", "plan": "pro"}`. Stored with the conversation |
| **Bindings (JSON)** | only the tools | Internal IDs and lookup keys. Never shown to the model, never stored |
| **Session From** | — | Field names from Context/Bindings (comma-separated). The same values always continue the same conversation, like a webhook `derive` |

Flat objects only (text, number, boolean): up to 50 fields, 2,000 characters in total for Context
and 16,000 for Bindings. **Never put credentials here** — use a tenant secret. These fields need an
admin/owner API key; with any other key the node fails with a clear message instead of running the
agent without them.

With *Continue On Fail*, the error item carries `kind` (`timeout`, `blocked`, `config`,
`quota_exceeded`…), `retryable`, `code` and the IDs (`requestId`, `executionId`, `sessionId`) so you
can branch on it. A turn that hit the server deadline comes back as `kind: timeout` with the
`sessionId` to resume.

**Client Message ID (Idempotency)** (Options): a UUID per message (e.g. `{{ $json.id }}` if it is a
UUID, or `{{ $uuid }}`… stored on the item). A retry with the same UUID and the same message never runs
the agent twice: while the first run is in flight you get a retryable *session busy* error; once it
finished, the stored answer is replayed (`idempotentReplay: true`). Needs a Zihin server from October
2026 or later; otherwise the node fails instead of silently running without the guarantee.

**Timeout**: the value you set is sent to the backend as its own budget, and the node waits a little
longer than that so the backend's own outcome arrives first. Leave it empty to use the default
(200s, above the backend's 180s stream budget). **Cancelling the workflow execution now cancels the
agent turn on the backend too** — it no longer keeps running and billing after you stop it.

Plan errors (trial expired, no subscription, quota exhausted) surface with a specific message and
are never retried; they are not credential problems.

## Zihin (Media Processing)

Process media files with Vision AI, Speech-to-Text, and Document parsing.

### Resources & Operations

| Resource | Operation | Description |
|----------|-----------|-------------|
| **Image** | Analyze | Vision AI analysis (GPT-4o, Claude) |
| **Audio** | Transcribe | Speech-to-text (Whisper) |
| **Document** | Parse | Extract content (PDF, Excel, CSV, DOCX) |

### Image Analysis

| Field | Required | Description |
|-------|----------|-------------|
| Image | Yes | URL or base64 data URI |
| Prompt | No | Analysis instructions |
| Extract Text | No | Enable OCR mode |
| Detail | No | low, high, auto |
| Provider | No | auto, openai, anthropic |

### Audio Transcription

| Field | Required | Description |
|-------|----------|-------------|
| Audio | Yes | URL or base64 data URI |
| Language | No | ISO code (pt, en, es...) |
| Include Timestamps | No | Add segment timestamps |
| Prompt Hint | No | Context for better accuracy |

**Supported formats:** mp3, wav, ogg, flac, m4a, webm, mp4

**Timeout (all media operations):** leave it at `0` (automatic). The node then waits just above the
server's own limit for each operation: 395s for transcription, 185s for image analysis and document
parsing. A lower value aborts work the server is still processing and billing. Workflows created
before 0.10.0 saved `120000` in this option: remove it to get the automatic value. The timeout covers
the whole request, and cancelling the workflow execution cancels the media request too.

### Document Parsing

| Field | Required | Description |
|-------|----------|-------------|
| Document | Yes | URL or base64 data URI |
| File Type | No | auto, pdf, xlsx, csv, docx |
| Extract Mode | No | text, tables, all |
| Sheet Name | No | Excel sheet name |
| Max Pages | No | PDF page limit |

### URL Tips

For **Google Drive** files, convert share links to direct download:

```
# Share link (won't work)
https://drive.google.com/file/d/FILE_ID/view?usp=sharing

# Direct download (works)
https://drive.google.com/uc?export=download&id=FILE_ID
```

---

## Troubleshooting

| Error | Solution |
|-------|----------|
| "Invalid API Key" | Verify the key in Zihin dashboard |
| "Invalid base URL" | Enable "Allow Custom Base URL" |
| "Timeout" | Increase timeout in Options |
| "Invalid file format" | Check supported formats |

---

## Security

### Protections

- **SSRF Prevention**: URL validation, private IPs blocked, HTTPS-only
- **Payload Limits**: Configurable size limits
- **Error Sanitization**: Sensitive data removed from errors
- **Telemetry Privacy**: IDs are hashed

### Best Practices

- Keep n8n updated (>=1.120.4)
- Use RBAC to restrict workflow editing
- Enable MFA for n8n access
- Rotate API keys periodically

### Credential Format

- Production: `zhn_live_xxx`
- Test: `zhn_test_xxx`

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## Links

- [Zihin Documentation](https://docs.zihin.ai)
- [Dashboard](https://console.zihin.ai)
- [GitHub Issues](https://github.com/zihin-ai/n8n-nodes-zihin/issues)

**License**: MIT | Developed by [Zihin AI Inc](https://zihin.ai)

---

Made by [Zihin.ai](https://www.zihin.ai). If this project is useful to you, a ⭐ helps others find it.
