"use client";

/**
 * TanStack Query hooks for every backend endpoint the UI uses: one useQuery per read and one
 * useMutation per write, all built on the typed `api` client and unwrap() from ./client.
 *
 * Errors surface as ApiError (lib/api/errors.ts) on `query.error` / `mutation.error`. Retry and stale-time
 * defaults are set on the QueryClient in components/providers.tsx (mutations are never retried there).
 * Cache coherence after writes is handled here by invalidating query-key prefixes (see invalidateFinancial).
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { api, newIdempotencyKey, unwrap } from "./client";
import type { paths, Schemas } from "./types";

// Extracts the (non-null) query-parameter type of a GET path from the generated contract, so list
// filters passed to the hooks below are type-checked against the backend's OpenAPI definition.
type Q<P extends keyof paths> = paths[P] extends { get: { parameters: { query?: infer T } } } ? NonNullable<T> : never;

/**
 * Query-key factory. The first element is the "root" used for prefix invalidation: invalidating
 * ["customer"] also refreshes ["customer", id, "invoices"], etc. List keys include the filter object,
 * so each filter combination is cached separately.
 */
export const keys = {
  dashboard: ["dashboard"] as const,
  insights: ["insights"] as const,
  settings: ["settings"] as const,
  ready: ["ready"] as const,
  customers: (q?: object) => ["customers", q ?? {}] as const,
  customer: (id: string) => ["customer", id] as const,
  customerInvoices: (id: string) => ["customer", id, "invoices"] as const,
  customerPayments: (id: string) => ["customer", id, "payments"] as const,
  invoices: (q?: object) => ["invoices", q ?? {}] as const,
  invoice: (id: string) => ["invoice", id] as const,
  invoicePayments: (id: string) => ["invoice", id, "payments"] as const,
  receivables: (q?: object) => ["receivables", q ?? {}] as const,
  receivablesSummary: ["receivables-summary"] as const,
  forecast: (h: number, g: string) => ["forecast", h, g] as const,
  bills: (q?: object) => ["bills", q ?? {}] as const,
  commitments: (q?: object) => ["commitments", q ?? {}] as const,
  actions: (q?: object) => ["actions", q ?? {}] as const,
  action: (id: string) => ["action", id] as const,
  audit: (q?: object) => ["audit", q ?? {}] as const,
};

/** Everything derived from the ledger. Refreshed after any financial write (payments, invoices, approvals). */
// "actions", "settings" and "ready" are deliberately absent; mutations that affect actions invalidate them
// explicitly. "payments" matches no key produced by `keys` (payment lists live under "customer"/"invoice").
const FINANCIAL_ROOTS = [
  "dashboard", "insights", "customers", "customer", "invoices", "invoice", "receivables", "receivables-summary",
  "forecast", "bills", "commitments", "audit", "payments", "payment-attempts",
];

/**
 * Marks every ledger-derived query stale (active ones refetch immediately). The browser never patches
 * financial figures locally; it always re-reads them from the backend after a write.
 */
export function invalidateFinancial(qc: QueryClient) {
  return Promise.all(FINANCIAL_ROOTS.map((root) => qc.invalidateQueries({ queryKey: [root] })));
}

// ------------------------------------------------------------------ reads

/**
 * Every pending payment attempt of the business (server-side registry, backend API 1.1.0), independent of
 * any list's pagination. Pending attempts are few; the first 200 are returned and `total` says if there are more.
 */
export const usePendingPaymentAttempts = () =>
  useQuery({
    queryKey: ["payment-attempts", { status: "pending" }],
    queryFn: () => unwrap(api.GET("/api/v1/payment-attempts", { params: { query: { status: "pending", page_size: 200 } } })),
  });

export const useDashboard = () =>
  useQuery({ queryKey: keys.dashboard, queryFn: () => unwrap(api.GET("/api/v1/dashboard")) });

export const useInsights = () =>
  useQuery({ queryKey: keys.insights, queryFn: () => unwrap(api.GET("/api/v1/insights")) });

export const useSettings = () =>
  useQuery({ queryKey: keys.settings, queryFn: () => unwrap(api.GET("/api/v1/business/settings")) });

/** Backend capability check (voice provider configured?). Public endpoint. */
export const useReadiness = () =>
  useQuery({
    queryKey: keys.ready,
    staleTime: 60_000,
    retry: false,
    // Uses plain fetch, not kairaFetch/unwrap: the endpoint needs no session, and a "not ready" response is
    // still useful, so the checks are read from `data` on success or from `error.details` on failure.
    queryFn: async () => {
      const res = await fetch("/api/backend/api/v1/ready", { cache: "no-store" });
      const body = await res.json().catch(() => null);
      return (body?.data ?? body?.error?.details ?? null) as { checks?: Record<string, string> } | null;
    },
  });

export const useCustomers = (query: Q<"/api/v1/customers"> = {}) =>
  useQuery({ queryKey: keys.customers(query), queryFn: () => unwrap(api.GET("/api/v1/customers", { params: { query } })) });

export const useCustomer = (id: string) =>
  useQuery({
    queryKey: keys.customer(id),
    queryFn: () => unwrap(api.GET("/api/v1/customers/{customer_id}", { params: { path: { customer_id: id } } })),
  });

// The per-customer and per-invoice sub-lists below request a single page of up to 200 rows; there is no
// pagination here, so anything beyond 200 rows is not fetched.
export const useCustomerInvoices = (id: string) =>
  useQuery({
    queryKey: keys.customerInvoices(id),
    queryFn: () =>
      unwrap(api.GET("/api/v1/customers/{customer_id}/invoices", { params: { path: { customer_id: id }, query: { page_size: 200 } } })),
  });

export const useCustomerPayments = (id: string) =>
  useQuery({
    queryKey: keys.customerPayments(id),
    queryFn: () =>
      unwrap(api.GET("/api/v1/customers/{customer_id}/payments", { params: { path: { customer_id: id }, query: { page_size: 200 } } })),
  });

// `enabled` lets a caller hold the request until its inputs are ready.
export const useInvoices = (query: Q<"/api/v1/invoices"> = {}, enabled = true) =>
  useQuery({
    queryKey: keys.invoices(query),
    enabled,
    queryFn: () => unwrap(api.GET("/api/v1/invoices", { params: { query } })),
  });

export const useInvoice = (id: string) =>
  useQuery({
    queryKey: keys.invoice(id),
    queryFn: () => unwrap(api.GET("/api/v1/invoices/{invoice_id}", { params: { path: { invoice_id: id } } })),
  });

export const useInvoicePayments = (id: string) =>
  useQuery({
    queryKey: keys.invoicePayments(id),
    queryFn: () =>
      unwrap(api.GET("/api/v1/invoices/{invoice_id}/payments", { params: { path: { invoice_id: id }, query: { page_size: 200 } } })),
  });

export const useReceivables = (query: Q<"/api/v1/receivables"> = {}) =>
  useQuery({ queryKey: keys.receivables(query), queryFn: () => unwrap(api.GET("/api/v1/receivables", { params: { query } })) });

export const useReceivablesSummary = () =>
  useQuery({ queryKey: keys.receivablesSummary, queryFn: () => unwrap(api.GET("/api/v1/receivables/summary")) });

// Cash-flow forecast; defaults to a 90-day daily series. Horizon and granularity are part of the cache key.
export const useForecast = (horizon_days = 90, granularity: "daily" | "weekly" = "daily") =>
  useQuery({
    queryKey: keys.forecast(horizon_days, granularity),
    queryFn: () => unwrap(api.GET("/api/v1/cashflow/forecast", { params: { query: { horizon_days, granularity } } })),
  });

export const useBills = (query: Q<"/api/v1/bills"> = {}) =>
  useQuery({ queryKey: keys.bills(query), queryFn: () => unwrap(api.GET("/api/v1/bills", { params: { query } })) });

export const useCommitments = (query: Q<"/api/v1/payment-commitments"> = {}) =>
  useQuery({
    queryKey: keys.commitments(query),
    queryFn: () => unwrap(api.GET("/api/v1/payment-commitments", { params: { query } })),
  });

export const useActions = (query: Q<"/api/v1/actions"> = {}) =>
  useQuery({ queryKey: keys.actions(query), queryFn: () => unwrap(api.GET("/api/v1/actions", { params: { query } })) });

export const useAuditLogs = (query: Q<"/api/v1/audit-logs"> = {}) =>
  useQuery({ queryKey: keys.audit(query), queryFn: () => unwrap(api.GET("/api/v1/audit-logs", { params: { query } })) });

// ------------------------------------------------------------------ writes
// Every POST/PATCH below goes through kairaFetch, which adds X-CSRF-Token and handles one refresh/CSRF retry.
// Customer creation only touches customer lists, so it does not invalidate ledger-derived data.
export function useCreateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["CustomerCreate"]) => unwrap(api.POST("/api/v1/customers", { body })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["customers"] }),
  });
}

export function useUpdateCustomer(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["CustomerUpdate"]) =>
      unwrap(api.PATCH("/api/v1/customers/{customer_id}", { params: { path: { customer_id: id } }, body })),
    // Writes the returned record into the detail cache, then refreshes customer lists.
    // Note: invalidating ["customers"] does not cover ["customer", id], which is updated only by setQueryData.
    onSuccess: (data) => {
      qc.setQueryData(keys.customer(id), data);
      return qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}

export function useCreateInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["InvoiceCreate"]) => unwrap(api.POST("/api/v1/invoices", { body })),
    onSuccess: () => invalidateFinancial(qc),
  });
}

export function useUpdateInvoice(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["InvoiceUpdate"]) =>
      unwrap(api.PATCH("/api/v1/invoices/{invoice_id}", { params: { path: { invoice_id: id } }, body })),
    onSuccess: () => invalidateFinancial(qc),
  });
}

/**
 * Records a payment. The caller supplies an idempotency key that is created once per form
 * submission and reused on retry, so a retried request can never record a second payment.
 */
export function useRecordPayment(invoiceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ body, idempotencyKey }: { body: Schemas["PaymentCreate"]; idempotencyKey: string }) =>
      unwrap(
        api.POST("/api/v1/invoices/{invoice_id}/payments", {
          // Idempotency-Key is one of the headers the proxy forwards upstream (lib/server/proxy.ts).
          params: { path: { invoice_id: invoiceId }, header: { "Idempotency-Key": idempotencyKey } },
          body,
        }),
      ),
    onSuccess: () => invalidateFinancial(qc),
  });
}

export function useCreateBill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["BillCreate"]) => unwrap(api.POST("/api/v1/bills", { body })),
    onSuccess: () => invalidateFinancial(qc),
  });
}

/** Records a payment against a bill; same idempotency-key contract as useRecordPayment. */
export function usePayBill(billId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ body, idempotencyKey }: { body: Schemas["BillPaymentCreate"]; idempotencyKey: string }) =>
      unwrap(
        api.POST("/api/v1/bills/{bill_id}/payments", {
          params: { path: { bill_id: billId }, header: { "Idempotency-Key": idempotencyKey } },
          body,
        }),
      ),
    onSuccess: () => invalidateFinancial(qc),
  });
}

export function useCreateCommitment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["CommitmentCreate"]) => unwrap(api.POST("/api/v1/payment-commitments", { body })),
    onSuccess: () => invalidateFinancial(qc),
  });
}

// Settings include opening cash, low-cash threshold, collection delay and timezone, which feed ledger-derived
// figures, so a settings change also invalidates financial views.
export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["BusinessSettingsUpdate"]) => unwrap(api.PATCH("/api/v1/business/settings", { body })),
    onSuccess: (data) => {
      qc.setQueryData(keys.settings, data);
      return invalidateFinancial(qc);
    },
  });
}

// What-if delay scenario (result is flagged as a simulation); it records nothing, so nothing is invalidated.
export function useSimulation() {
  return useMutation({
    mutationFn: (body: Schemas["SimulationRequest"]) => unwrap(api.POST("/api/v1/cashflow/simulate", { body })),
  });
}

// Generates an editable reminder draft for a customer; the backend does not send it anywhere.
export function useReminder() {
  return useMutation({
    mutationFn: (body: Schemas["ReminderRequest"]) => unwrap(api.POST("/api/v1/assistant/reminder", { body })),
  });
}

/**
 * Sends a (possibly edited) transcript to the assistant. The result `kind` is proposal, answer, reminder
 * or unknown; a proposal becomes a proposed action that changes nothing until approved, so only the
 * actions list is refreshed.
 */
export function useExtract() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["ExtractRequest"]) => unwrap(api.POST("/api/v1/assistant/extract", { body })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["actions"] }),
  });
}

// Replaces the full operation list of a pending action (PATCH /actions/{id}); not a partial patch.
export function useEditAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (operations: Schemas["Operation"][]) =>
      unwrap(api.PATCH("/api/v1/actions/{action_id}", { params: { path: { action_id: id } }, body: { operations } })),
    onSuccess: (data) => {
      qc.setQueryData(keys.action(id), data);
      return qc.invalidateQueries({ queryKey: ["actions"] });
    },
  });
}

/**
 * Approves a proposed action (owner only); the backend executes its operations transactionally, so both the
 * actions list and every financial view are refreshed (sequentially) on success.
 */
export function useApproveAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/actions/{action_id}/approve", { params: { path: { action_id: id } } })),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["actions"] });
      await invalidateFinancial(qc);
    },
  });
}

export function useRejectAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason?: string) =>
      unwrap(
        api.POST("/api/v1/actions/{action_id}/reject", {
          params: { path: { action_id: id } },
          // An empty reason is omitted rather than sent as "".
          body: reason ? { reason } : {},
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["actions"] }),
  });
}

// Re-exported so form components can import the key generator alongside the payment hooks.
export { newIdempotencyKey };
