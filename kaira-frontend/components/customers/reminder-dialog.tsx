"use client";

/**
 * Payment-reminder drafting. `ReminderDialog` asks the backend for a draft (POST /assistant/reminder via
 * useReminder) and `ReminderDraft` shows it for editing and copying.
 *
 * Used from the customer detail page (whole customer balance), the receivables page (optionally scoped to
 * one invoice) and, for ReminderDraft only, the voice assistant panel when extraction returns a reminder.
 * The backend computes the outstanding/overdue figures from the ledger; the client sends only ids,
 * language and tone. Nothing is sent to the customer by KAIRA.
 */
import { Copy } from "lucide-react";
import { useState } from "react";

import { Dialog } from "@/components/ui/dialog";
import { Money } from "@/components/ui/finance";
import { Field, FormError, Select, Textarea } from "@/components/ui/form";
import { Button, Notice } from "@/components/ui/primitives";
import { describeError } from "@/lib/api/errors";
import { useReminder } from "@/lib/api/hooks";
import type { LanguageCode, Reminder } from "@/lib/api/types";

/** Editable reminder draft. KAIRA never sends it; the owner copies it into WhatsApp/SMS themselves. */
export function ReminderDraft({ reminder }: { reminder: Reminder }) {
  // Local copy of the message: edits stay in the browser and are never saved back to the server.
  // State is seeded once from the prop; ReminderDialog keys the draft by message so a new draft remounts it.
  const [text, setText] = useState(reminder.message);
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-3 rounded-2xl bg-paper p-5 ring-1 ring-line" data-testid="reminder-draft">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-display font-semibold">Reminder for {reminder.customer_name}</p>
        {/* Outstanding and overdue are computed by the backend from the ledger when the draft is requested. */}
        <p className="text-sm text-muted">
          Outstanding <Money value={reminder.total_outstanding} className="font-semibold text-ink" /> · overdue{" "}
          <Money value={reminder.overdue_amount} className="font-semibold text-danger" />
        </p>
      </div>
      {/* generated_by says whether the text is the English template or a Sarvam translation of it; edits stay in this browser only. */}
      <Field label={`Draft (${reminder.language}${reminder.generated_by === "template" ? ", template" : ", translated by Sarvam"})`}>
        {(id) => <Textarea id={id} className="min-h-40" value={text} onChange={(e) => setText(e.target.value)} />}
      </Field>
      {/* `note` is the backend's disclaimer (by default "Draft only. KAIRA never sends reminders automatically."). */}
      <p className="text-xs text-muted">{reminder.note}</p>
      {/* Async Clipboard API (secure context required); a rejected write is not caught, so the label simply stays "Copy text". */}
      <Button
        variant="secondary"
        size="sm"
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        <Copy className="size-4" aria-hidden="true" /> {copied ? "Copied" : "Copy text"}
      </Button>
    </div>
  );
}

/**
 * Language/tone picker that requests a reminder draft.
 *
 * @param customerId customer whose outstanding balance the reminder covers
 * @param invoiceId  optional: limit the reminder to one invoice (sent as null otherwise)
 */
export function ReminderDialog({
  open,
  onClose,
  customerId,
  invoiceId,
}: {
  open: boolean;
  onClose: () => void;
  customerId: string;
  invoiceId?: string;
}) {
  const [language, setLanguage] = useState<LanguageCode>("en-IN");
  const [tone, setTone] = useState<"friendly" | "firm">("friendly");
  // A plain mutation with no cache invalidation: drafting a reminder changes no data.
  const reminder = useReminder();
  return (
    <Dialog open={open} onClose={onClose} title="Draft a payment reminder" description="Uses the real outstanding figures. Nothing is sent automatically." wide>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Language">
            {(id) => (
              <Select id={id} value={language} onChange={(e) => setLanguage(e.target.value as LanguageCode)}>
                <option value="en-IN">English</option>
                <option value="te-IN">Telugu</option>
                <option value="hi-IN">Hindi</option>
              </Select>
            )}
          </Field>
          <Field label="Tone">
            {(id) => (
              <Select id={id} value={tone} onChange={(e) => setTone(e.target.value as "friendly" | "firm")}>
                <option value="friendly">Friendly</option>
                <option value="firm">Firm (overdue)</option>
              </Select>
            )}
          </Field>
        </div>
        {/* te-IN/hi-IN drafts need the backend's Sarvam key; without it the backend returns English. */}
        {language !== "en-IN" && (
          <Notice tone="info">Telugu/Hindi drafts need the Sarvam key on the server. Without it, KAIRA returns English and says so.</Notice>
        )}
        {/* Each click requests a fresh draft; invoice_id is null for a whole-customer reminder. */}
        <Button
          onClick={() => reminder.mutate({ customer_id: customerId, invoice_id: invoiceId ?? null, language, tone })}
          loading={reminder.isPending}
        >
          Draft reminder
        </Button>
        <FormError message={reminder.error ? describeError(reminder.error) : null} />
        {/* Keyed by message text so a different draft remounts ReminderDraft and resets its editable copy. */}
        {reminder.data && <ReminderDraft key={reminder.data.message} reminder={reminder.data} />}
      </div>
    </Dialog>
  );
}
