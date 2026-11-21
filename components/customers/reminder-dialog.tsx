"use client";

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
  const [text, setText] = useState(reminder.message);
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-3 rounded-2xl bg-paper p-5 ring-1 ring-line" data-testid="reminder-draft">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-display font-semibold">Reminder for {reminder.customer_name}</p>
        <p className="text-sm text-muted">
          Outstanding <Money value={reminder.total_outstanding} className="font-semibold text-ink" /> · overdue{" "}
          <Money value={reminder.overdue_amount} className="font-semibold text-danger" />
        </p>
      </div>
      <Field label={`Draft (${reminder.language}${reminder.generated_by === "template" ? ", template" : ", translated by Sarvam"})`}>
        {(id) => <Textarea id={id} className="min-h-40" value={text} onChange={(e) => setText(e.target.value)} />}
      </Field>
      <p className="text-xs text-muted">{reminder.note}</p>
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
        {language !== "en-IN" && (
          <Notice tone="info">Telugu/Hindi drafts need the Sarvam key on the server. Without it, KAIRA returns English and says so.</Notice>
        )}
        <Button
          onClick={() => reminder.mutate({ customer_id: customerId, invoice_id: invoiceId ?? null, language, tone })}
          loading={reminder.isPending}
        >
          Draft reminder
        </Button>
        <FormError message={reminder.error ? describeError(reminder.error) : null} />
        {reminder.data && <ReminderDraft key={reminder.data.message} reminder={reminder.data} />}
      </div>
    </Dialog>
  );
}
