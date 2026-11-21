"use client";

import { useState, type FormEvent } from "react";

import { useSession, useToast } from "@/components/providers";
import { Field, FormError, Input } from "@/components/ui/form";
import { Button, Card, ErrorState, LoadingBlock, Notice, PageHeader } from "@/components/ui/primitives";
import { describeError } from "@/lib/api/errors";
import { useSettings, useUpdateSettings } from "@/lib/api/hooks";
import type { Schemas } from "@/lib/api/types";
import { isValidAmount } from "@/lib/format/money";

function SettingsForm({ business }: { business: Schemas["BusinessOut"] }) {
  const toast = useToast();
  const update = useUpdateSettings();
  const [name, setName] = useState(business.name);
  const [type, setType] = useState(business.business_type ?? "");
  const [opening, setOpening] = useState(business.opening_cash_balance);
  const [openingDate, setOpeningDate] = useState(business.opening_cash_as_of);
  const [delay, setDelay] = useState(String(business.overdue_collection_delay_days));
  const [threshold, setThreshold] = useState(business.low_cash_threshold);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Business name is required.");
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(opening)) return setError("Opening cash must be a non-negative amount.");
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(threshold) && !isValidAmount(threshold)) return setError("Threshold must be a non-negative amount.");
    const d = Number(delay);
    if (!Number.isInteger(d) || d < 0 || d > 365) return setError("Overdue collection delay must be 0–365 days.");
    try {
      await update.mutateAsync({
        name: name.trim(),
        business_type: type.trim() || null,
        opening_cash_balance: opening,
        opening_cash_as_of: openingDate,
        overdue_collection_delay_days: d,
        low_cash_threshold: threshold,
      });
      toast("Settings saved");
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Business name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Business type">{(id) => <Input id={id} value={type} onChange={(e) => setType(e.target.value)} />}</Field>
        <Field label="Opening cash (₹)" hint="Cash held at the start of the opening date">
          {(id, d) => <Input id={id} aria-describedby={d} inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} />}
        </Field>
        <Field label="Opening cash date" hint="Movements before this date are treated as already included">
          {(id, d) => <Input id={id} aria-describedby={d} type="date" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} />}
        </Field>
        <Field label="Overdue collection delay (days)" hint="When overdue invoices without a promise are expected, counted from today">
          {(id, d) => <Input id={id} aria-describedby={d} type="number" min={0} max={365} value={delay} onChange={(e) => setDelay(e.target.value)} />}
        </Field>
        <Field label="Cash safety threshold (₹)" hint="Projected balances below this are shortfalls">
          {(id, d) => <Input id={id} aria-describedby={d} inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} />}
        </Field>
      </div>
      <p className="text-xs text-muted">Currency {business.currency} · timezone {business.timezone}</p>
      <FormError message={error} />
      <Button type="submit" loading={update.isPending}>Save settings</Button>
    </form>
  );
}

export default function SettingsPage() {
  const { isOwner } = useSession();
  const settings = useSettings();
  return (
    <>
      <PageHeader title="Business settings" subtitle="These values shape your cash position and forecast." />
      {!isOwner ? (
        <Notice tone="warn">Only the business owner can change settings.</Notice>
      ) : (
        <Card className="max-w-3xl">
          {settings.isError && <ErrorState error={settings.error} onRetry={() => settings.refetch()} />}
          {settings.isPending && <LoadingBlock rows={4} />}
          {settings.data && <SettingsForm business={settings.data} />}
        </Card>
      )}
    </>
  );
}
