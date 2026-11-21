// @vitest-environment node
// Node's native FormData/Blob/Request behave like the browser's for multipart bodies.
/**
 * Contract tests for the voice helpers (lib/api/voice.ts): the multipart field names /voice/transcribe
 * expects, the "voice not configured" error path, and decoding of base64 text-to-speech audio.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setSessionFromServer, setTransport } from "@/lib/api/client";
import { speechToObjectUrl, transcribe } from "@/lib/api/voice";

// Envelope builders and a capturing fake transport, as in api-client.test.ts.
const ok = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data, error: null }), { status: 200, headers: { "content-type": "application/json" } });
const fail = (status: number, code: string, message = code) =>
  new Response(JSON.stringify({ success: false, data: null, error: { code, message, details: null } }), {
    status,
    headers: { "content-type": "application/json" },
  });
let calls: Request[] = [];
function route(handler: (req: Request) => Response) {
  calls = [];
  setTransport(async (req) => {
    calls.push(req.clone());
    return handler(req);
  });
}
// Every test starts with a known in-memory CSRF token.
beforeEach(() => setSessionFromServer({ csrf_token: "csrf-0" } as never));

describe("voice", () => {
  // Upload is an unsafe POST, so besides the field names the CSRF token must be attached.
  it("posts multipart with `file` and `language_code` exactly as the contract defines", async () => {
    route(() => ok({ transcript: "hello", language_code: "te-IN", language_probability: null, provider: "sarvam", model: "saaras:v4", request_id: "r" }));
    const result = await transcribe(new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm;codecs=opus" }), "te-IN");
    expect(result.transcript).toBe("hello");
    const form = await calls[0].formData();
    expect(form.get("language_code")).toBe("te-IN");
    expect((form.get("file") as File).name).toBe("recording.webm");
    expect(calls[0].headers.get("x-csrf-token")).toBe("csrf-0");
  });

  // "unknown" language means auto-detect, so the field is omitted; a backend without SARVAM_API_KEY must surface as a typed 503.
  it("omits language_code for auto-detect and surfaces PROVIDER_NOT_CONFIGURED", async () => {
    route(() => fail(503, "PROVIDER_NOT_CONFIGURED", "Speech-to-text is unavailable because SARVAM_API_KEY is not configured."));
    const err = await transcribe(new Blob([new Uint8Array(300)], { type: "audio/webm" }), "unknown").catch((e) => e);
    expect(err).toMatchObject({ code: "PROVIDER_NOT_CONFIGURED", status: 503 });
    expect((await calls[0].formData()).get("language_code")).toBeNull();
  });

  // TTS audio arrives as base64 JSON; it must become a Blob with the declared MIME type and exact byte length (4 for "RIFF").
  it("decodes base64 TTS audio into a typed blob URL", () => {
    const create = vi.fn(() => "blob:audio");
    URL.createObjectURL = create;
    const url = speechToObjectUrl({ audio_base64: btoa("RIFF"), mime_type: "audio/wav" } as never);
    expect(url).toBe("blob:audio");
    const blob = (create.mock.calls[0] as unknown as [Blob])[0];
    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(4);
  });
});
