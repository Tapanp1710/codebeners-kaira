# KAIRA live voice agent: interface contract (API 1.2.0)

This is the contract between the backend agent (`app/services/agent/`, `app/api/v1/endpoints/agent.py`) and the
frontend voice client. Sarvam contracts were verified against docs.sarvam.ai on 2026-11-22.

## Flow

```
browser mic (getUserMedia: echoCancellation, noiseSuppression, autoGainControl)
  -> AudioWorklet: mono, resample to 16 kHz, Int16 little-endian PCM, ~100 ms frames
  -> WS /api/v1/agent/live (binary frames)
  -> backend -> Sarvam realtime STT  wss://api.sarvam.ai/speech-to-text-realtime/ws
               (saaras:v4, language_code=auto, stream_type=fast, linear16/16000, endpointing=vad, keyterms=customer names)
  <- vad.speech_start / transcript.partial / transcript.final
  -> transcript.final -> agent turn (sarvam-105b tool calling over the business tool registry)
  <- turn/tool events, reply text
  -> Sarvam streaming TTS  wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v4-flash (linear16 PCM)
  <- binary PCM frames to the browser -> AudioContext playback
```

The Sarvam key exists only in the backend process. The browser authenticates the WebSocket with a short-lived
ticket, because Next.js route handlers cannot proxy WebSockets.

## REST (cookie session + `X-CSRF-Token` like every other write)

| Method | Path | Body | Returns (`data`) |
|---|---|---|---|
| POST | `/api/v1/agent/session` | `{"resume_session_id": uuid \| null}` | `{session_id, ticket, ws_url, expires_in, voice_configured, stt_model, tts_model}` |
| POST | `/api/v1/agent/turn` | `{"text", "turn_id"?, "language"?}` | `{turn_id, reply, language, ignored, replayed, duration_ms, events[]}` (typed turn, same agent) |
| GET | `/api/v1/agent/conversation` | | `[{turn_id, role: "user"\|"assistant", text, language, at, facts}]` (oldest first, ≤ 50) |
| GET | `/api/v1/agent/sessions/{id}` | | usage: `stt_audio_seconds_billed`, `stt_audio_seconds_sent`, `tts_characters`, `llm_calls`, `provider_errors` |

`turn_id` is client-generated (`[A-Za-z0-9_.:-]{1,64}`). Sending the same `turn_id` again returns the stored
reply (`replayed: true`) and runs no tool again. That is how a client recovers a turn whose response was lost.

## WebSocket `GET {ws_url}?ticket=<ticket>`

The ticket is valid for 60 s. Ask `POST /agent/session` again (with `resume_session_id`) for each reconnect. The
`Origin` header must be one of the backend's `CORS_ORIGINS`. Close codes: `1008` bad origin/ticket, `1000` normal.

### Client -> server

| Frame | Meaning |
|---|---|
| binary | Int16 LE mono PCM at 16 000 Hz. Any frame size; the server re-chunks to 100 ms. Send continuously while the live session is on and not muted (silence included: Sarvam's VAD needs it). |
| `{"type":"mute"}` / `{"type":"unmute"}` | Stop/resume forwarding audio. The UI should also stop sending frames when muted. |
| `{"type":"interrupt"}` | Stop the current spoken reply (barge-in from a UI button). |
| `{"type":"text","text":"...","turn_id":"..."}` | A typed utterance in the same conversation. |
| `{"type":"ping"}` | -> `{"type":"pong"}` |

### Server -> client

Binary frames are Int16 LE mono PCM at the `sample_rate` given in the preceding `tts.start` (22 050 Hz by default),
belonging to the current reply. Play them in order, gaplessly. Drop everything buffered on `tts.stop`.

| `type` | Fields | Meaning |
|---|---|---|
| `status` | `stt?: "connected"\|"reconnecting"`, `listening`, `muted`, `reason?` | Connection state |
| `vad` | `speech: bool` | Sarvam's server VAD: user started/stopped speaking |
| `transcript.partial` | `text`, `language`, `first_partial_ms?` | Live caption. **Never acted on.** |
| `transcript.final` | `text`, `language`, `language_confidence` | One utterance; starts a turn |
| `transcript.echo` | `text` | A final that matched KAIRA's own speech; dropped |
| `turn.started` | `turn_id`, `text`, `language` | |
| `thinking` | `turn_id` | An LLM call is in progress |
| `tool.started` | `turn_id`, `tool`, `kind: "read"\|"write"`, `arguments` | |
| `tool.completed` | `turn_id`, `tool`, `kind`, `status`, `summary`, `result`, `refresh: string[]`, `replayed` | `status`: `completed`, `needs_clarification`, `needs_confirmation`, `needs_owner_approval`, `error`, `rejected`, `unsupported`, `drafted` |
| `navigate` | `turn_id`, `path` | The agent asks the UI to show a screen |
| `focus` / `navigate_hint` | `entity`, `id` / `path` | Optional context hints |
| `reply` | `turn_id`, `text`, `language`, `duration_ms?`, `replayed?` | What KAIRA will say |
| `ignored` | `turn_id`, `text` | The utterance was not addressed to KAIRA; nothing was done |
| `turn.completed` | `turn_id`, `ignored`, `response_ms`, `llm_calls`, `tools[]` | |
| `turn.cancelled` / `turn.failed` | `turn_id`, `message?` | |
| `tts.start` | `turn_id`, `sample_rate`, `speaker`, `language` | PCM frames follow |
| `tts.first_audio` | `turn_id`, `ms_from_utterance_end` | Latency measurement |
| `tts.end` | `turn_id` | All audio for the reply was sent |
| `tts.stop` | `reason: "speech"\|"user"\|"new_turn"` | Barge-in: stop playback now and drop queued audio |
| `error` | `source: "stt"\|"tts"\|"config"`, `code`, `message`, `fatal` | `fatal` = the session cannot continue |

`refresh` values: `financial` (invalidate every ledger-derived query) and `customers`.

## Barge-in and echo

1. Server: `vad.speech_start` while a reply is playing cancels the reply's TTS socket and sends `tts.stop`.
2. Client: on `tts.stop`, stop all scheduled audio sources immediately. A client-side VAD may also duck or stop
   playback early, but the server VAD is authoritative.
3. Echo: the browser's echo cancellation is the first defence. The server also drops a final transcript that
   closely matches the text KAIRA was speaking within the last 2 s (`transcript.echo`).

## Autonomy policy (server-side; the model cannot override it)

| Situation | Result |
|---|---|
| Owner, all values evidenced in the user's own words, customer/invoice resolved, no soft warning except a defaulted date | Executed immediately (`completed`) |
| Fuzzy customer match, removed unsupported value, possible duplicate customer, or `AGENT_AUTONOMY=confirm` | `needs_confirmation` (proposal stored; `confirm_pending_action` executes it after a spoken yes) |
| Missing amount/customer, ambiguous customer or invoice, over-payment | `needs_clarification`; nothing stored |
| Staff user | `needs_owner_approval`; the owner approves in the app |
| Payment amount correction | An increase records only the difference after confirmation; a decrease is refused (no reversal service exists) |

Financial writes run through the existing proposal pipeline (`analyse` -> `create_proposal` -> `approve`): row
locks, per-operation idempotency keys, audit rows linked to the action, exactly once. Each tool call also has an
execution record keyed by `(turn_id, tool, arguments)`.

## Limits

* The browser listens only while the page is open, the user has enabled the live session, and microphone
  permission is granted. System-wide background listening needs a native desktop or mobile app.
* Raw audio is not stored. Transcripts and replies are stored as conversation history.
* The reply text is produced by one LLM call after the tools finish. Speech starts as soon as that reply exists and
  is streamed sentence by sentence; LLM token streaming is not used.
