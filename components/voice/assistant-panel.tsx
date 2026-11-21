"use client";

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

const LANGUAGES: { value: TranscribeLanguage; label: string }[] = [
  { value: "unknown", label: "Auto-detect" },
  { value: "en-IN", label: "English" },
  { value: "te-IN", label: "తెలుగు Telugu" },
  { value: "hi-IN", label: "हिन्दी Hindi" },
];

export const EXAMPLES = [
  "Ramesh paid me 5,000 rupees today. He will clear the remaining amount next Monday.",
  "How much do my customers owe me?",
  "What happens if my biggest customer pays 15 days late?",
];

export function AssistantPanel() {
  const readiness = useReadiness();
  const voiceConfigured = readiness.data?.checks?.voice_provider === "configured";
  const extractionProvider = readiness.data?.checks?.extraction_provider;
  const [language, setLanguage] = useState<TranscribeLanguage>("unknown");
  const [transcript, setTranscript] = useState("");
  const [inputMode, setInputMode] = useState<"text" | "voice">("text");
  const [detected, setDetected] = useState<string | null>(null);
  const [orb, setOrb] = useState<OrbState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractResponse | null>(null);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const extract = useExtract();

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
  const recorder = useRecorder(onAudio);

  // Recorder status drives the orb directly while capturing; otherwise the workflow state does.
  const orbState: OrbState =
    recorder.status === "recording" ? "listening" : recorder.status === "requesting" ? "processing" : recorder.status === "error" ? "error" : orb;
  const shownError = recorder.status === "error" && recorder.error ? RECORDER_MESSAGES[recorder.error] : error;

  useEffect(() => () => audioRef.current?.pause(), []);

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

  async function onUnderstand() {
    if (!transcript.trim()) return;
    setError(null);
    setResult(null);
    setOrb("processing");
    try {
      const lang = language === "unknown" ? ((detected as LanguageCode | null) ?? undefined) : language;
      const res = await extract.mutateAsync({ transcript: transcript.trim(), language: lang ?? null, input_mode: inputMode });
      setResult(res);
      setOrb("ready");
    } catch (err) {
      setOrb("error");
      setError(describeError(err));
    }
  }

  async function onSpeak(text: string, lang: string) {
    setSpeechError(null);
    setOrb("speaking");
    try {
      const speech = await speak(text, (["te-IN", "hi-IN", "en-IN"].includes(lang) ? lang : "en-IN") as LanguageCode);
      const url = speechToObjectUrl(speech);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        setOrb("ready");
      };
      await audio.play();
    } catch (err) {
      setOrb("ready");
      setSpeechError(`Could not read the answer aloud: ${describeError(err)}`);
    }
  }

  const busy = extract.isPending || orbState === "processing";

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
