# ChatGPT Web API Handbook

This handbook records what `pro-cli` has validated about the ChatGPT web app API through local Chrome/CDP observation as of May 8, 2026.

`pro-cli` uses a logged-in ChatGPT browser tab. It does not call the public OpenAI API. It submits requests from inside the web page so the request carries the same cookies, session token, frontend headers, sentinel headers, and streaming behavior as ChatGPT web.

These endpoints are private ChatGPT web endpoints, not a stable API contract. Treat field names and request shapes as observed behavior that needs fresh verification before broad changes.

## Runtime Path

The normal request path is:

```txt
pro-cli command
  -> ~/.pro-cli auth/session state
  -> Chrome DevTools Protocol page evaluation
  -> https://chatgpt.com/backend-api/f/conversation
  -> streamed SSE response
  -> local job/result storage
```

The Chrome window must stay open while jobs run. The local daemon manages job execution; the user or agent manages the browser login.

Do not commit raw captures. Request bodies and streams can include prompts, resume tokens, profile/context metadata, request ids, and account/session-derived state.

## Observed Endpoints

Live ChatGPT web traffic used these endpoints during Pro conversation requests:

```txt
GET  /api/auth/session
GET  /backend-api/models
GET  /backend-api/conversations
POST /backend-api/f/conversation
POST /backend-api/f/conversation/prepare
GET  /backend-api/f/conversation/resume
POST /backend-api/sentinel/chat-requirements/prepare
POST /backend-api/sentinel/chat-requirements/finalize
```

The conversation endpoint is the primary submission endpoint. The prepare and sentinel endpoints produce request validation state. The resume endpoint supports long streams and reconnects.

### Account / Plan / PII Endpoints

Probed via CDP page evaluation (May 8, 2026):

```txt
GET  /backend-api/accounts/check/v4-2023-04-27   200  account + plan + features (no remaining counters)
GET  /backend-api/me                             200  email, name, phone, MFA flag, picture (PII)
GET  /public-api/conversation_limit              200  {"message_cap":0.0,...} (zeroed, not useful)
```

`accounts/check/v4-2023-04-27` is the canonical place for plan facts. The shape includes:

```json
{
  "accounts": {
    "<account-uuid>": {
      "account": { "plan_type": "pro", "structure": "personal", ... },
      "entitlement": {
        "subscription_plan": "chatgptpro",
        "has_active_subscription": true,
        "expires_at": "...",
        "renews_at": "...",
        "billing_period": "monthly"
      },
      "features": ["gpt5_pro", "o3_pro", "canvas", ...]
    }
  }
}
```

`/backend-api/me` returns user PII — handle with care. `pro-cli` should not log or persist its body.

### Endpoints That Do Not Exist

Probed and confirmed 404/405 (do not re-probe):

```txt
/backend-api/conversation_limits_progress   404
/backend-api/conversation_limit             404
/backend-api/conversation_limits            404
/public-api/conversation_limit/v2           404
/backend-api/me/usage                       404
/backend-api/me/limits                      404
/backend-api/me/quota                       404
/backend-api/me/feature_limits              404
/backend-api/usage                          404
/backend-api/usage_metrics                  404
/backend-api/billing/usage                  404
/backend-api/billing/subscription           404
/backend-api/subscription                   404
/backend-api/feature_limits                 404
/backend-api/limits                         404
/backend-api/limits_progress                404
/backend-api/rate_limits                    404
/backend-api/conversation_meta              404
/backend-api/account/check                  404
/backend-api/accounts/check                 405
```

**Conclusion: there is no standalone "remaining calls" endpoint.** Per-feature counters only appear inside the SSE stream as `conversation_detail_metadata.limits_progress` events on real conversation turns (see Limits section below). Pro general chat throttling is adaptive; no published cap exists.

## Request Shape

`pro-cli` currently sends a body shaped like:

```json
{
  "action": "next",
  "messages": [
    {
      "id": "<uuid>",
      "author": { "role": "user" },
      "create_time": 1778265252,
      "content": {
        "content_type": "text",
        "parts": ["<prompt>"]
      },
      "metadata": {}
    }
  ],
  "model": "gpt-5-5-pro",
  "thinking_effort": "standard",
  "parent_message_id": "client-created-root",
  "client_prepare_state": "none",
  "timezone_offset_min": 360,
  "timezone": "America/Denver",
  "conversation_mode": { "kind": "primary_assistant" },
  "enable_message_followups": true,
  "system_hints": [],
  "supports_buffering": true,
  "supported_encodings": ["v1"],
  "client_contextual_info": { "app_name": "chatgpt.com" },
  "paragen_cot_summary_display_override": "allow",
  "force_parallel_switch": "auto",
  "history_and_training_disabled": true
}
```

Continuing a saved conversation adds:

```json
{
  "conversation_id": "<conversation-id>",
  "parent_message_id": "<parent-message-id>",
  "history_and_training_disabled": false
}
```

## Response Stream

The `/backend-api/f/conversation` response is an SSE stream. A simple Pro request produced these event shapes:

```txt
event: delta_encoding
data: "v1"

data: {"type":"resume_conversation_token", ...}
data: {"p":"","o":"add","v":{"message":{...},"conversation_id":"..."},"c":0}
data: {"type":"input_message", ...}
data: {"type":"stream_handoff", ...}
data: {"type":"server_ste_metadata", ...}
data: {"type":"conversation_detail_metadata", ...}
data: {"type":"message_stream_complete", ...}
data: [DONE]
```

The final assistant text appears in message content patches or assistant message snapshots:

```json
{
  "message": {
    "author": { "role": "assistant" },
    "content": {
      "content_type": "text",
      "parts": ["answer text"]
    },
    "status": "finished_successfully",
    "end_turn": true
  }
}
```

## Useful Metadata

The stream exposes useful metadata that `pro-cli` does not fully surface yet.

### Conversation and Continuation

Useful fields:

```txt
conversation_id
message.id
input_message.id
parent_id
request_id
turn_exchange_id
turn_trace_id
```

These can support better continuation UX. `pro-cli` could return `conversationId`, `assistantMessageId`, and `parentMessageId` after successful calls so agents do not need to inspect ChatGPT manually.

### Reasoning Progress

Useful fields:

```txt
message.metadata.initial_text
message.metadata.finished_text
message.metadata.finished_duration_sec
message.metadata.reasoning_start_time
message.metadata.reasoning_end_time
message.metadata.pro_progress
message.metadata.thinking_effort
```

Observed examples:

```txt
initial_text: Reasoning
finished_text: Finished reasoning
finished_text: Thought for 7s
finished_duration_sec: 7
pro_progress: 71.42857142857143
thinking_effort: standard
```

These can improve `job wait` and `job create --wait` by showing live progress to the agent or terminal user.

### Model Resolution

Useful fields:

```txt
model_slug
resolved_model_slug
default_model_slug
did_auto_switch_to_reasoning
auto_switcher_race_winner
thinking_effort
```

These fields can prove which model actually handled the turn. This is useful because `pro-cli` defaults to `gpt-5-5-pro`, while ChatGPT web's picker may have its own default.

### Limits

`conversation_detail_metadata` exposed:

```json
{
  "limits_progress": [
    {
      "feature_name": "deep_research",
      "remaining": 250,
      "reset_after": "2026-06-07T18:34:14.421525+00:00"
    },
    {
      "feature_name": "odyssey",
      "remaining": 398,
      "reset_after": "2026-05-17T21:31:20.421544+00:00"
    }
  ],
  "model_limits": []
}
```

Wired into `pro-cli limits` as a stream-side capture: `transport.ts` extracts `limits_progress` from `conversation_detail_metadata` events and persists snapshots to the local SQLite. `pro-cli limits` returns plan info from `accounts/check` plus the most recent observed counters.

Observed `feature_name` values so far: `deep_research`, `odyssey`. These are specialty-feature quotas, not general chat caps. Free-tier features (gpt5, etc.) do not appear here on Pro.

### Tools and Search

Useful fields:

```txt
tool_invoked
tool_name
is_search
search_tool_call_count
search_tool_query_types
citations
content_references
search_result_groups
```

These fields are usually null or empty for a plain text request. They are likely useful when exploring Deep Research, web search, file handling, and tool-enabled modes.

## Logprobs Finding

A live experiment tried these request variants:

```json
{ "logprobs": true, "top_logprobs": 5 }
{ "include_logprobs": true, "top_logprobs": 5 }
{ "response_options": { "logprobs": true, "top_logprobs": 5 } }
```

All variants returned HTTP 200 and normal answer text. None produced token probability fields in the response stream. The web endpoint appears to ignore those fields, at least for `gpt-5-5-pro` through `/backend-api/f/conversation`.

This does not prove no internal endpoint can expose logprobs. It means the current web conversation path does not expose them in the stream.

## 2026-07-29 Findings

Validated live against the authenticated session on July 29, 2026.

### Model Catalog Refresh

`GET /backend-api/models` now includes the GPT-5.6 generation:

```txt
gpt-5-6-pro        GPT-5.6 Pro       reasoning_type=pro   thinking_efforts=["standard"]  max_tokens=410000
gpt-5-6-thinking   GPT-5.6 Thinking  reasoning_type=reasoning  min/standard/extended/max  max_tokens=262144
gpt-5.6-sol-wm     GPT-5.6 Sol       reasoning_type=reasoning  min/standard/extended/max
gpt-5.6-terra-wm   GPT-5.6 Terra     reasoning_type=reasoning  min/standard/extended/max
gpt-5.6-luna-wm    GPT-5.6 Luna      reasoning_type=reasoning  min/standard/extended/max
```

`gpt-5-6-pro` advertises only `standard` thinking effort; `gpt-5-5-pro` remains available with `standard` and `extended` ("Extended Pro") but its picker category is tagged `subcategory: "Legacy models"`. `pro-cli` now defaults to `gpt-5-6-pro`.

### Extended Reasoning Probe (gpt-5-6-pro)

Same-day probes of `thinking_effort` handling on `gpt-5-6-pro`, temporary chats, one prompt per run:

```txt
requested effort   HTTP   stream echo                       resolved_model_slug   behavior
standard           200    thinking_effort: "standard"       gpt-5-6-pro           normal
extended           200    thinking_effort: "extended"       gpt-5-6-pro           normal
max (never valid   200    thinking_effort: "max"            gpt-5-6-pro           normal
for pro models)
```

Conclusions:

- The stream's `thinking_effort` metadata is a request mirror, not proof of applied effort: `max` is echoed verbatim even though no Pro model has ever exposed it. The field is not validated per model server-side.
- No stream field discriminates applied effort: no paragen/parallel/sample-count markers, `auto_switcher_race_winner: null`, `did_auto_switch_to_reasoning: false` in every run.
- Reasoning durations on a shared moderately hard prompt were indistinguishable (gpt-5-6-pro standard 32s, extended 19s, gpt-5-5-pro extended 29s), so duration evidence is inconclusive at this prompt difficulty.
- Product-side the answer is clear: the web picker offers no Extended toggle for GPT-5.6 Pro, so "extended on 5.6 Pro" does not exist as a product feature. Treat unlisted efforts as no-ops. `pro-cli` therefore rejects `--reasoning` values the static catalog does not list for a known model and clamps unsupported configured defaults to `standard`.

### Temporary Chats Still Cannot Generate Images

A temporary-chat request (`history_and_training_disabled: true`) asking for image generation produced an assistant turn that stated the image generation tool is not available in temporary chats, then fell back to writing an SVG through code interpreter. The image tool is only mounted in saved conversations; `--model image` continues to force saved mode.

### image_gen Limits Counter

`conversation_detail_metadata.limits_progress` now includes an `image_gen` feature counter (observed `remaining: 935` with a daily-looking `reset_after`). It flows into `pro-cli limits` through the existing stream-side capture alongside `deep_research` and `odyssey`.

### File Upload (Attachments)

Three-step upload used by `--attach`:

```txt
POST /backend-api/files                          {file_name, file_size, use_case: "multimodal", ...}
                                                 -> {status: "success", file_id: "file_0000...", upload_url}
PUT  <upload_url>                                raw bytes, x-ms-blob-type: BlockBlob
POST /backend-api/files/{file_id}/uploaded       -> {status: "success", download_url}
```

The `upload_url` host (`*.oaiusercontent.com`) is Cloudflare-fronted and rejects non-browser TLS signatures (403 error 1010), so the PUT must run inside the CDP page like the conversation calls. Attached images ride in the user message as:

```json
{
  "content_type": "multimodal_text",
  "parts": [
    { "content_type": "image_asset_pointer", "asset_pointer": "file-service://<file_id>", "size_bytes": 0, "width": 0, "height": 0 },
    "<prompt>"
  ]
}
```

plus `metadata.attachments: [{id, name, size, mime_type, width, height}]`. Note: conversation polling sees the uploaded file as an `image_asset_pointer` part too, so result extraction must exclude uploaded file ids or it returns the source image as the "generated" output.

### Conversation Cleanup Endpoints

```txt
PATCH /backend-api/conversation/{id}  {"is_archived": true|false}   200 {"success":true}   archive/unarchive
PATCH /backend-api/conversation/{id}  {"is_visible": false}         200 {"success":true}   ChatGPT's delete
GET   /backend-api/conversations?offset=&limit=&order=updated       sidebar list (archived items drop out)
```

These work with plain bearer-token fetches outside the browser (no sentinel required). `pro-cli` deletes image conversations after downloading results and exposes `conversations list|archive|delete`.

## Exploration Playbook

Use CDP network tracing and keep each experiment small.

Good toggles to trace:

- Model picker changes
- `standard` vs `extended` thinking
- Temporary vs saved conversations
- Continuing a conversation
- Regenerate and retry
- Cancel during reasoning
- Search/web tool toggles
- Deep Research mode
- File upload
- Image generation
- Canvas or agent mode

For each experiment, capture:

- Request URL and method
- Request body
- Response status
- Raw SSE event types
- New fields or changed fields
- Whether fields are stable across two runs
- Whether the data is safe to expose in normal output

Prefer curated metadata over raw stream dumps. Raw streams may include resume tokens, profile/context metadata, request ids, and account/session-derived state.

Good follow-up questions:

- Which fields are stable across `standard` and `extended` reasoning?
- Which continuation ids are required for saved conversations, temporary conversations, regenerate, and retry?
- Can Deep Research be started with the same conversation endpoint, or does it require a separate mode/tool path?
- Which limit fields are available before a job starts?
- Can resume events be used to recover long-running jobs after daemon restart?

## Upgrade Candidates

The highest-value `pro-cli` upgrades are:

1. Return curated response metadata with full results.
2. Show live reasoning progress while waiting.
3. Return continuation ids after successful calls.
4. Add limits reporting.
5. Add a redacted response-shape capture tool for future discovery.
