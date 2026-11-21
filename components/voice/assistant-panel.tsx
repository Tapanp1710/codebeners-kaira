"use client";

/**
 * The KAIRA assistant: voice or typed request -> transcript -> structured result.
 *
 * Flow:
 * 1. Tap the orb: `useRecorder` captures up to 30 s of audio (explicit, user-started only).
 * 2. The clip goes to POST /voice/transcribe (multipart); the transcript lands in an editable textarea.
 * 3. "Understand" sends the (possibly edited) text to POST /assistant/extract via `useExtract`.
 * 4. The response is one of: a proposal (rendered by ProposalCard for owner approval - nothing is
 *    written to the ledger here), an answer (optionally read aloud via POST /voice/speak),
 *    a reminder draft, or an "unknown" message.
 *
 * Mounted only inside the app shell's assistant sheet, which unmounts it on close.
 * GET /ready tells the panel whether the server has a voice provider (Sarvam) configured.
 */
import { MessageSquareText, Sparkles, Volume2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ProposalCard } from "@/components/actions/proposal-card";
import { ReminderDraft } from "@/components/customers/reminder-dialog";
import { Field, FormError, Select, Textarea } from "@/components/ui/form";
import { Button, Notice } from "@/components/ui/primitives";
import { describeError } from "@/lib/api/errors";
import { useExtract, useReadiness } from "@/lib/api/hooks";
import type { ExtractResponse, LanguageCode } from "@/lib/api/types";
import { speak, speechToObjectUrl, transcribe, type TranscribeLanguage } from "@/lib/api/voice";
import { RECORDER_MESSAGES, useRecorder } from "@/hooks/use-recorder";

import { VoiceOrb, type OrbState } from "./voice-orb";

// "unknown" means no language_code is sent to transcription, letting the provider detect it.
const LANGUAGES: { value: TranscribeLanguage; label: string }[] = [
  { value: "unknown", label: "Auto-detect" },
  { value: "en-IN", label: "English" },
  { value: "te-IN", label: "తెలుగు Telugu" },
  { value: "hi-IN", label: "हिन्दी Hindi" },
];

/** One-tap sample requests covering the three main intents: record a payment/promise, ask a question, run a what-if. */
export const EXAMPLES = [
  "Ramesh paid me 5,000 rupees today. He will clear the remaining amount next Monday.",
  "How much do my customers owe me?",
  "What happens if my biggest customer pays 15 days late?",
];

/** Self-contained assistant UI; takes no props. All state is local and is discarded when the sheet closes. */
export function AssistantPanel() {
  // Readiness is fetched with plain fetch (public endpoint, 60 s stale, no retry). Until it loads,
  // `voiceConfigured` is false, but the warning notices below wait for `isSuccess` so they never flash.
  const readiness = useReadiness();
  const voiceConfigured = readiness.data?.checks?.voice_provider === "configured";
  const extractionProvider = readiness.data?.checks?.extraction_provider;
  const [language, setLanguage] = useState<TranscribeLanguage>("unknown");
  const [transcript, setTranscript] = useState("");
  // Sent to /assistant/extract as `input_mode`. Becomes "voice" after a transcription and "text" when an
  // example is picked; manual edits of a transcribed text keep it at "voice".
  const [inputMode, setInputMode] = useState<"text" | "voice">("text");
  // Language reported by the speech-to-text service (used when the selector is on Auto-detect).
  const [detected, setDetected] = useState<string | null>(null);
  // Workflow part of the orb state (processing/ready/speaking/error); recorder status overrides it below.
  const [orb, setOrb] = useState<OrbState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractResponse | null>(null);
  // Kept separate from `error` so a failed read-aloud does not hide the answer it belongs to.
  const [speechError, setSpeechError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // useExtract invalidates the "actions" queries on success, so a new proposal also bumps the shell's approval badge.
  const extract = useExtract();

  /**
   * Recorder completion handler: uploads the clip for transcription and fills the textarea.
   * It does not call extract automatically - the user always sees and can edit the transcript first.
   * An empty transcript is treated as an error so the user is prompted to retry or type.
   */
  const onAudio = useCallback(
    async (audio: Blob) => {
      setOrb("processing");
      setError(null);
      try {
        const t = await transcribe(audio, language);
        setTranscript(t.transcript);
        setDetected(t.language_code);
        setInputMode("voice");
        setOrb(t.transcript ? "ready" : "error");
        if (!t.transcript) setError("No speech was recognised. Try again or type your request.");
      } catch (err) {
        setOrb("error");
        setError(describeError(err));
      }
    },
    [language],
  );
  // useRecorder keeps the latest onAudio in a ref, so changing the language mid-session is picked up.
  // Microphone failures (unsupported browser, permission denied, no device, empty clip) surface as
  // recorder.status === "error" with a RecorderError code rather than as thrown exceptions.
  const recorder = useRecorder(onAudio);

  // Recorder status drives the orb directly while capturing; otherwise the workflow state does.
  const orbState: OrbState =
    recorder.status === "recording" ? "listening" : recorder.status === "requesting" ? "processing" : recorder.status === "error" ? "error" : orb;
  // Recorder errors take priority and are mapped to user-facing text (each suggests typing instead).
  const shownError = recorder.status === "error" && recorder.error ? RECORDER_MESSAGES[recorder.error] : error;

  // On unmount (sheet closed), stop any answer that is still being read aloud.
  useEffect(() => () => audioRef.current?.pause(), []);

  /** Orb toggle: stop if recording; otherwise clear the previous result/errors and start a fresh recording. */
  function onOrbPress() {
    if (recorder.status === "recording") recorder.stop();
    else {
      setError(null);
      setResult(null);
      setOrb("idle");
      recorder.reset();
      recorder.start();
    }
  }

  /**
   * Sends the current transcript to POST /assistant/extract. The backend decides the intent and
   * returns a proposal, answer, reminder or unknown result; proposals are stored server-side as
   * pending actions awaiting approval, not executed.
   */
  async function onUnderstand() {
    if (!transcript.trim()) return;
    setError(null);
    setResult(null);
    setOrb("processing");
    try {
      // An explicit language choice wins; on Auto-detect use the STT-detected code, or null (backend decides).
      const lang = language === "unknown" ? ((detected as LanguageCode | null) ?? undefined) : language;
      const res = await extract.mutateAsync({ transcript: transcript.trim(), language: lang ?? null, input_mode: inputMode });
      setResult(res);
      setOrb("ready");
    } catch (err) {
      setOrb("error");
      setError(describeError(err));
    }
  }

  /**
   * Reads an answer aloud, only on an explicit button press. POST /voice/speak returns base64 audio
   * (text is truncated to 2,500 characters in lib/api/voice.ts), which is decoded into a Blob object URL
   * and played. Unsupported answer languages fall back to en-IN.
   */
  async function onSpeak(text: string, lang: string) {
    setSpeechError(null);
    setOrb("speaking");
    try {
      const speech = await speak(text, (["te-IN", "hi-IN", "en-IN"].includes(lang) ? lang : "en-IN") as LanguageCode);
      const url = speechToObjectUrl(speech);
      const audio = new Audio(url);
      // The ref is only used for the unmount pause; the object URL is revoked when playback ends.
      audioRef.current = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        setOrb("ready");
      };
      await audio.play();
    } catch (err) {
      // Covers both the API call and audio.play() rejections (e.g. browser autoplay policy).
      setOrb("ready");
      setSpeechError(`Could not read the answer aloud: ${describeError(err)}`);
    }
  }

  // While busy the orb is disabled, except during recording so the user can always tap to stop.
  const busy = extract.isPending || orbState === "processing";

  // Rendering notes: a hidden span mirrors orbState for tests (data-testid="orb-state"). Without a
  // voice provider, warnings explain that only typed English works (rules-based extraction when the
  // server reports extraction_provider "rules"). Result blocks are chosen by `result.kind`; an answer may
  // be shown in English when translation is unavailable (`language` differs from `answer_language`).
  return (
    <div className="space-y-5">
      <div className="flex flex-col items-center gap-2 rounded-2xl bg-navy px-4 py-6 text-cream">
        <VoiceOrb state={orbState} onPress={onOrbPress} disabled={busy && recorder.status !== "recording"} seconds={recorder.seconds} />
        <span className="sr-only" data-testid="orb-state">{orbState}</span>
        <p className="max-w-xs text-center text-xs text-cream/70">Tap once to start, tap again to stop. KAIRA only listens while the orb is active.</p>
      </div>

      {readiness.isSuccess && !voiceConfigured && (
        <Notice tone="warn" title="Voice is not available on this server yet">
          Speech-to-text, spoken answers and Telugu/Hindi understanding need the Sarvam API key on the KAIRA server.
          Typed requests in English work now{extractionProvider === "rules" ? " (built-in English understanding)" : ""}.
        </Notice>
      )}

      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Field label="Your request" hint={detected ? `Detected language: ${detected}` : "Speak, or type and edit before KAIRA reads it."}>
          {(id, d) => (
            <Textarea
              id={id}
              aria-describedby={d}
              value={transcript}
              onChange={(e) => {
                setTranscript(e.target.value);
                if (orb === "error") setOrb("idle");
              }}
              placeholder={EXAMPLES[0]}
              data-testid="assistant-input"
            />
          )}
        </Field>
        <Field label="Language">
          {(id) => (
            <Select id={id} value={language} onChange={(e) => setLanguage(e.target.value as TranscribeLanguage)} className="sm:w-40">
              {LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      {!voiceConfigured && readiness.isSuccess && (language === "te-IN" || language === "hi-IN") && (
        <Notice tone="warn">Telugu and Hindi requests need the Sarvam key on the server; without it KAIRA only understands English.</Notice>
      )}
      <div className="flex flex-wrap gap-2">
        <Button onClick={onUnderstand} loading={extract.isPending} disabled={!transcript.trim() || busy} data-testid="assistant-submit">
          <Sparkles className="size-4" aria-hidden="true" /> Understand
        </Button>
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => {
              setTranscript(ex);
              setInputMode("text");
            }}
            className="rounded-full bg-paper px-3 py-1.5 text-left text-xs text-muted ring-1 ring-line hover:text-ink"
          >
            {ex.length > 48 ? `${ex.slice(0, 48)}…` : ex}
          </button>
        ))}
      </div>

      <FormError message={shownError} />

      {result?.kind === "proposal" && result.proposal && (
        <div className="space-y-2">
          <p className="text-sm text-muted">KAIRA prepared this for your review. Nothing is recorded until the owner approves.</p>
          <ProposalCard key={result.proposal.id} action={result.proposal} />
        </div>
      )}
      {result?.answer && (
        <div className="rounded-2xl bg-paper p-5 ring-1 ring-line" data-testid="assistant-answer">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
            <MessageSquareText className="size-4" aria-hidden="true" /> Answer (calculated from your books)
          </p>
          <p className="mt-2 text-base leading-relaxed">{result.answer.answer}</p>
          {result.answer.language !== result.answer.answer_language && (
            <p className="mt-2 text-xs text-muted">Shown in English: translation to {result.answer.language} needs the Sarvam key.</p>
          )}
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => onSpeak(result.answer!.answer, result.answer!.answer_language)}>
            <Volume2 className="size-4" aria-hidden="true" /> Read aloud
          </Button>
          {speechError && <p className="mt-2 text-sm text-danger" role="alert">{speechError}</p>}
        </div>
      )}
      {result?.kind === "reminder" && result.reminder && <ReminderDraft reminder={result.reminder} />}
      {result?.kind === "unknown" && result.message && <Notice tone="info">{result.message}</Notice>}
    </div>
  );
}
