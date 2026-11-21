"use client";

import { api, API_BASE, kairaFetch, unwrap } from "./client";
import type { LanguageCode, Speech, Transcription } from "./types";

export type TranscribeLanguage = LanguageCode | "unknown";

/**
 * POST /voice/transcribe - multipart/form-data with `file` (audio) and optional `language_code`,
 * exactly as defined by Body_transcribe_api_v1_voice_transcribe_post in the contract.
 * The browser sets the multipart boundary; the proxy forwards the raw bytes unchanged.
 */
export async function transcribe(audio: Blob, language: TranscribeLanguage): Promise<Transcription> {
  const form = new FormData();
  const ext = audio.type.includes("mp4") ? "m4a" : audio.type.includes("ogg") ? "ogg" : "webm";
  form.append("file", audio, `recording.${ext}`);
  if (language !== "unknown") form.append("language_code", language);
  const request = new Request(`${API_BASE}/api/v1/voice/transcribe`, { method: "POST", body: form });
  return unwrap<Transcription>(
    (async () => {
      const response = await kairaFetch(request);
      const data = await response.json().catch(() => undefined);
      return response.ok ? { data, response } : { error: data, response };
    })(),
  );
}

/** POST /voice/speak - returns base64 audio (SpeechOut). Never sends anything automatically. */
export function speak(text: string, language_code: LanguageCode): Promise<Speech> {
  return unwrap(api.POST("/api/v1/voice/speak", { body: { text: text.slice(0, 2500), language_code } }));
}

/** Decodes SpeechOut into a playable object URL (caller revokes it). */
export function speechToObjectUrl(speech: Speech): string {
  const binary = atob(speech.audio_base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: speech.mime_type }));
}
