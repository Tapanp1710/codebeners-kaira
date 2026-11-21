"use client";

/**
 * Business settings (owner only). These four values feed the backend's cash position and forecast:
 * opening cash balance + its as-of date, the overdue collection delay, and the low-cash (shortfall)
 * threshold. Reads GET /api/v1/business/settings and saves with PATCH /api/v1/business/settings.
 */
import { useState, type FormEvent } from "react";

import { useSession, useToast } from "@/components/providers";
import { Field, FormError, Input } from "@/components/ui/form";
import { Button, Card, ErrorState, LoadingBlock, Notice, PageHeader } from "@/components/ui/primitives";
import { describeError } from "@/lib/api/errors";
import { useSettings, useUpdateSettings } from "@/lib/api/hooks";
import type { Schemas } from "@/lib/api/types";
import { isValidAmount } from "@/lib/format/money";

/**
 * Edit form, mounted only once settings have loaded, so the inputs are seeded from server data exactly once.
 * Money fields stay decimal strings (as the API sends them) and are never converted to floating point.
 */
function SettingsForm({ business }: { business: Schemas["BusinessOut"] }) {
  const toast = useToast();
  const update = useUpdateSettings();
  const [name, setName] = useState(business.name);
  const [type, setType] = useState(business.business_type ?? "");
  const [opening, setOpening] = useState(business.opening_cash_balance);
  const [openingDate, setOpeningDate] = useState(business.opening_cash_as_of);
  // Kept as text for the number input; parsed and range-checked on submit.
  const [delay, setDelay] = useState(String(business.overdue_collection_delay_days));
  const [threshold, setThreshold] = useState(business.low_cash_threshold);
  const [error, setError] = useState<string | null>(null);

  /**
   * Lightweight client checks before the PATCH. The backend stays authoritative: its validation errors come back
   * as ApiError and are shown inline via describeError. Mutations are never auto-retried (see Providers).
   */
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Business name is required.");
    // Up to 12 integer digits and 2 decimals; zero is allowed, a minus sign is not.
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(opening)) return setError("Opening cash must be a non-negative amount.");
    // isValidAmount() requires a positive value matching the same pattern, so in practice the regex alone
    // decides here and a zero threshold is accepted.
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(threshold) && !isValidAmount(threshold)) return setError("Threshold must be a non-negative amount.");
    const d = Number(delay);
    // Same 0–365 range as the input's min/max; the input attributes alone are not enforced (form is noValidate).
    if (!Number.isInteger(d) || d < 0 || d > 365) return setError("Overdue collection delay must be 0–365 days.");
    try {
      // An empty business type is sent as null to clear it. Currency and timezone are display-only here.
      // On success useUpdateSettings writes the response into the settings cache and invalidates every
      // ledger-derived query, because the forecast and dashboard depend on these values.
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

/**
 * Page wrapper. isOwner comes from the server-provided session (role === "owner"); staff see a notice instead
 * of the form. useSettings() still runs for everyone because hooks cannot be called conditionally; only the
 * rendering is gated. The backend independently rejects settings changes from non-owners (403).
 */
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
