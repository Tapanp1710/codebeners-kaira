"use client";

import { useState } from "react";

import { ProposalCard } from "@/components/actions/proposal-card";
import { Pager } from "@/components/ui/pager";
import { cn, EmptyState, ErrorState, LoadingBlock, PageHeader } from "@/components/ui/primitives";
import { useActions } from "@/lib/api/hooks";

const TABS = [
  { value: "pending", label: "Awaiting approval" },
  { value: "executed", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "", label: "All" },
] as const;

export default function ActionsPage() {
  const [status, setStatus] = useState<(typeof TABS)[number]["value"]>("pending");
  const [page, setPage] = useState(1);
  const actions = useActions({ status: status || undefined, page, page_size: 10 });
  return (
    <>
      <PageHeader title="Approvals" subtitle="Everything KAIRA understood from your requests. Nothing is recorded until the owner approves it." />
      <div role="tablist" aria-label="Proposal status" className="mb-6 inline-flex flex-wrap rounded-full bg-paper p-1 ring-1 ring-line">
        {TABS.map((t) => (
          <button
            key={t.value}
            role="tab"
            aria-selected={status === t.value}
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
          Use the KAIRA orb (bottom right) to speak or type a request.
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
