"use client";

/**
 * Browser-side voice API: speech-to-text upload and text-to-speech playback helpers.
 *
 * Used by components/voice/assistant-panel.tsx together with hooks/use-recorder.ts. Both calls go
 * through kairaFetch (CSRF header, refresh-and-retry) and unwrap() (envelope -> data or ApiError),
 * and the /voice/ paths get the client's long (95 s) timeout and the proxy's 90 s upstream timeout.
 */
import { api, API_BASE, apiUrl, kairaFetch, unwrap } from "./client";
import type { LanguageCode, Speech, Transcription } from "./types";

// "unknown" means "let the backend detect the language": no language_code field is sent.
export type TranscribeLanguage = LanguageCode | "unknown";

/**
 * POST /voice/transcribe - multipart/form-data with `file` (audio) and optional `language_code`,
 * exactly as defined by Body_transcribe_api_v1_voice_transcribe_post in the contract.
 * The browser sets the multipart boundary; the proxy forwards the raw bytes unchanged.
 *
 * Built as a raw Request rather than via the typed `api` client so the FormData body is passed through
 * untouched; unwrap() is fed an object shaped like an openapi-fetch result ({ data | error, response }).
 */
export async function transcribe(audio: Blob, language: TranscribeLanguage): Promise<Transcription> {
  const form = new FormData();
  // File extension follows the recorder's MIME type (MediaRecorder output differs per browser).
  const ext = audio.type.includes("mp4") ? "m4a" : audio.type.includes("ogg") ? "ogg" : "webm";
  form.append("file", audio, `recording.${ext}`);
  if (language !== "unknown") form.append("language_code", language);
  // No content-type header is set on purpose: the browser adds multipart/form-data with its boundary.
  const request = new Request(apiUrl(`${API_BASE}/api/v1/voice/transcribe`), { method: "POST", body: form });
  return unwrap<Transcription>(
    (async () => {
      const response = await kairaFetch(request);
      // A non-JSON body (e.g. an HTML error page) becomes undefined, which unwrap() maps to HTTP_ERROR/INVALID_RESPONSE.
      const data = await response.json().catch(() => undefined);
      return response.ok ? { data, response } : { error: data, response };
    })(),
  );
}

/** POST /voice/speak - returns base64 audio (SpeechOut). Never sends anything automatically. */
export function speak(text: string, language_code: LanguageCode): Promise<Speech> {
  // Text is capped at 2,500 characters client-side before it is sent.
  return unwrap(api.POST("/api/v1/voice/speak", { body: { text: text.slice(0, 2500), language_code } }));
}

/** Decodes SpeechOut into a playable object URL (caller revokes it). */
export function speechToObjectUrl(speech: Speech): string {
  // atob() yields a binary string; copy it byte-by-byte into a Uint8Array to build the Blob.
  const binary = atob(speech.audio_base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: speech.mime_type }));
}
