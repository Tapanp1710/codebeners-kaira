"use client";

/**
 * Approvals screen. Lists the proposed actions the assistant produced from voice/typed requests
 * (POST /assistant/extract via the orb) and hosts one ProposalCard per proposal, where the owner can edit,
 * approve or reject it. Nothing reaches the books until approval: approving calls
 * POST /api/v1/actions/{id}/approve, and only then does the backend execute the operations.
 */
import { useState } from "react";

import { ProposalCard } from "@/components/actions/proposal-card";
import { Pager } from "@/components/ui/pager";
import { cn, EmptyState, ErrorState, LoadingBlock, PageHeader } from "@/components/ui/primitives";
import { useActions } from "@/lib/api/hooks";

// Tab values are the backend's `status` filter. "" means "All" and is sent as no filter. The API also has a
// "failed" status, which has no tab of its own and is only visible under All.
const TABS = [
  { value: "pending", label: "Awaiting approval" },
  { value: "executed", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "", label: "All" },
] as const;

/** Client page: status tab + page number drive a paginated GET /api/v1/actions (10 per page). */
export default function ActionsPage() {
  const [status, setStatus] = useState<(typeof TABS)[number]["value"]>("pending");
  const [page, setPage] = useState(1);
  // The params are part of the React Query key, so each tab/page combination is cached separately.
  // Switching tabs resets to page 1 (see the tab onClick) so a stale page number cannot point past the end.
  const actions = useActions({ status: status || undefined, page, page_size: 10 });
  // Error (with retry), first-load skeleton and an empty state tailored to the pending tab are rendered from
  // the query state. Cards are keyed by id + updated_at: ProposalCard copies its `action` prop into local state
  // and updates it from mutation responses, so a refetch that brings a newer version must remount the card
  // instead of leaving its local copy stale. Approve/reject invalidate ["actions"] plus every ledger query, so
  // an approved proposal drops out of the "Awaiting approval" list on refetch. Approve/reject controls are
  // hidden for non-owners inside ProposalCard; the backend enforces the same rule with 403.
  return (
    <>
      <PageHeader title="Approvals" subtitle="Everything KAIRA understood from your requests. Nothing is recorded until the owner approves it." />
      {/* A filter, not a tab widget: toggle buttons in a labelled group (Tab moves between them, aria-pressed marks the current one). */}
      <div role="group" aria-label="Proposal status" className="mb-6 inline-flex flex-wrap rounded-full bg-paper p-1 ring-1 ring-line">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            aria-pressed={status === t.value}
            onClick={() => { setStatus(t.value); setPage(1); }}
            className={cn("rounded-full px-4 py-1.5 text-sm font-semibold", status === t.value ? "bg-navy text-cream" : "text-muted hover:text-ink")}
          >
            {t.label}
          </button>
        ))}
      </div>
      {actions.isError && <ErrorState error={actions.error} onRetry={() => actions.refetch()} />}
      {actions.isPending && <LoadingBlock rows={3} />}
      {actions.data && actions.data.items.length === 0 && (
        <EmptyState title={status === "pending" ? "Nothing waiting for approval" : "No proposals here"}>
          Talk to KAIRA (the orb on the KAIRA screen or the dock at the bottom of every page).
        </EmptyState>
      )}
      <div className="space-y-5">
        {actions.data?.items.map((a) => (
          <ProposalCard key={`${a.id}-${a.updated_at}`} action={a} />
        ))}
      </div>
      {actions.data && actions.data.total > 0 && <Pager page={page} total={actions.data.total} pageSize={actions.data.page_size} onPage={setPage} />}
    </>
  );
}
