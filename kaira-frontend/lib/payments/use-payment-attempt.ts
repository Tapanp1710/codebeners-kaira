"use client";

/**
 * Payment submission and recovery for one invoice or bill, shared by PaymentDialog and PayBillDialog.
 *
 * Sources of a pending (unconfirmed) payment, in order of precedence:
 *   1. a conflicting server attempt just reported by the backend (another tab/device registered first);
 *   2. this browser's local record (it carries the key, for registrations that may not have arrived);
 *   3. the server's pending attempt for this invoice/bill (any device; survives cleared storage).
 *
 * Rules: an uncertain payment is never discarded and never gets a new key; the fields are frozen; the local
 * record is released only on a confirmed outcome or a definitive rejection (server-side states). Fresh
 * submissions re-check local storage and the server under a per-target Web Lock; without Web Locks the
 * backend's one-pending-attempt constraint still decides (the loser adopts the winner's attempt).
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { useSession } from "@/components/providers";
import { ApiError, describeError } from "@/lib/api/errors";
import { invalidateFinancial, newIdempotencyKey } from "@/lib/api/hooks";
import { attemptStores } from "@/lib/api/payment-attempt";
import {
  bodyFromServer,
  getAttempt,
  listPendingAttempts,
  runLocalAttempt,
  runServerAttempt,
  type Kind,
  type LocalAttempt,
  type Outcome,
  type PaymentBody,
  type ServerAttempt,
} from "@/lib/payments/server-attempts";

export const PENDING_ELSEWHERE =
  "A payment for this is already awaiting confirmation. Retry it before recording a new payment.";

export type PendingView = { body: PaymentBody; attemptId?: string; source: "local" | "server" };

export function pendingQueryKey(kind: Kind, targetId: string) {
  return ["payment-attempts", { status: "pending", resource_type: kind, resource_id: targetId }] as const;
}

/** Server pending attempt for one invoice/bill (any device). */
export function useServerPending(kind: Kind, targetId: string) {
  return useQuery({
    queryKey: pendingQueryKey(kind, targetId),
    queryFn: () => listPendingAttempts({ resource_type: kind, resource_id: targetId }),
  });
}

export function usePaymentAttempt(
  kind: Kind,
  targetId: string,
  { open, onDone, onConfirmedElsewhere }: { open: boolean; onDone: (a: ServerAttempt) => void; onConfirmedElsewhere: () => void },
) {
  const { session } = useSession();
  const qc = useQueryClient();
  const businessId = session?.business.id ?? "unknown";
  const userId = session?.user.id ?? "unknown";
  const store = attemptStores[kind];
  const server = useServerPending(kind, targetId);
  const [local, setLocalState] = useState<LocalAttempt | null>(() => store.load(businessId, targetId) as LocalAttempt | null);
  const localRef = useRef(local);
  const [conflict, setConflict] = useState<ServerAttempt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  // Completion markers newer than this were written while the dialog was open, i.e. by another tab.
  const openedAt = useRef(0);
  const handlers = useRef({ onDone, onConfirmedElsewhere });
  useEffect(() => {
    handlers.current = { onDone, onConfirmedElsewhere };
  });

  function setLocal(a: LocalAttempt | null) {
    localRef.current = a;
    setLocalState(a);
  }
  const reloadLocal = () => setLocal(store.load(businessId, targetId) as LocalAttempt | null);
  const refreshServer = () => qc.invalidateQueries({ queryKey: ["payment-attempts"] });

  const serverItem = server.data?.items?.[0];
  const pending: PendingView | null = conflict
    ? { body: bodyFromServer(conflict), attemptId: conflict.id, source: "server" }
    : local
      ? { body: local.body, attemptId: local.attemptId, source: "local" }
      : serverItem
        ? { body: bodyFromServer(serverItem), attemptId: serverItem.id, source: "server" }
        : null;

  useEffect(() => {
    if (open || openedAt.current === 0) openedAt.current = Date.now();
  }, [open]);

  // Other tabs: follow local-record changes; a confirmation elsewhere closes this dialog.
  useEffect(
    () =>
      store.subscribe((remote) => {
        if (inFlight.current) return;
        const before = localRef.current;
        const now = store.load(businessId, targetId) as LocalAttempt | null;
        setLocal(now);
        if (remote) {
          void refreshServer();
          void invalidateFinancial(qc);
        }
        if (before && !now && store.loadDone(businessId, targetId)?.key === before.key) handlers.current.onConfirmedElsewhere();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscription keyed by target only.
    [businessId, targetId, kind],
  );

  function handle(outcome: Outcome) {
    reloadLocal();
    void refreshServer();
    switch (outcome.type) {
      case "done":
        setConflict(null);
        setError(null);
        void invalidateFinancial(qc);
        handlers.current.onDone(outcome.attempt);
        return;
      case "definitive":
        setConflict(null);
        setError(describeError(outcome.error));
        return;
      case "conflict":
        setConflict(outcome.attempt);
        setError("Another payment for this was started in another tab or on another device. It is shown here; retry it to confirm it.");
        return;
      case "uncertain":
        setError(describeError(outcome.error));
    }
  }

  async function guarded(fn: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await store.withLock(businessId, targetId, fn);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  /** A new payment. Refuses (and shows the existing one) if any unconfirmed payment exists locally or on the server. */
  function submit(body: PaymentBody, onBlocked?: (message: string) => void) {
    return guarded(async () => {
      const stored = store.load(businessId, targetId) as LocalAttempt | null;
      if (stored) {
        setLocal(stored);
        setError(PENDING_ELSEWHERE);
        return;
      }
      let fresh;
      try {
        fresh = await listPendingAttempts({ resource_type: kind, resource_id: targetId });
      } catch (err) {
        setError(describeError(err));
        return;
      }
      qc.setQueryData(pendingQueryKey(kind, targetId), fresh);
      if (fresh.items.length > 0) {
        setError(PENDING_ELSEWHERE);
        return;
      }
      const done = store.loadDone(businessId, targetId);
      if (done && done.at > openedAt.current) {
        const message = "A payment for this was just recorded in another tab. Close this and check the updated balance before paying again.";
        setError(message);
        onBlocked?.(message);
        return;
      }
      const idField = kind === "bill" ? "billId" : "invoiceId";
      const created = store.create({ key: newIdempotencyKey(), businessId, userId, body, [idField]: targetId } as never);
      const attempt = created.attempt as unknown as LocalAttempt;
      setLocal(attempt);
      if (!created.created) {
        setError(PENDING_ELSEWHERE);
        return;
      }
      handle(await runLocalAttempt(kind, businessId, targetId, attempt));
    });
  }

  /** Retries the pending payment with its original key and request: local record first, else the server attempt. */
  function retry() {
    // The attempt on screen, so its outcome can be reported even if another tab or device resolved it.
    const shownId = conflict?.id ?? localRef.current?.attemptId ?? serverItem?.id;
    return guarded(async () => {
      if (conflict) {
        handle(await runServerAttempt(conflict.id));
        return;
      }
      const stored = store.load(businessId, targetId) as LocalAttempt | null;
      if (stored) {
        handle(await runLocalAttempt(kind, businessId, targetId, stored));
        return;
      }
      const latest = await listPendingAttempts({ resource_type: kind, resource_id: targetId }).catch(() => null);
      if (latest) qc.setQueryData(pendingQueryKey(kind, targetId), latest);
      const id = latest?.items[0]?.id;
      if (id) {
        handle(await runServerAttempt(id));
        return;
      }
      // Nothing pending any more: another tab or device resolved it meanwhile. Report its real outcome.
      reloadLocal();
      if (!shownId) return;
      try {
        const a = await getAttempt(shownId);
        if (a.status === "succeeded") handle({ type: "done", attempt: a });
        else if (a.status === "pending") handle(await runServerAttempt(a.id));
        else handle({ type: "definitive", error: new ApiError(422, { code: a.failure_code ?? "PAYMENT_REJECTED", message: a.failure_message ?? `This payment was ${a.status}.` }) });
      } catch (err) {
        handle({ type: "uncertain", error: err });
      }
    });
  }

  return { pending, locked: pending !== null, submitting, error, setError, submit, retry, serverLoading: server.isPending };
}
