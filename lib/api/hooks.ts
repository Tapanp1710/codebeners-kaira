"use client";

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { api, newIdempotencyKey, unwrap } from "./client";
import type { paths, Schemas } from "./types";

type Q<P extends keyof paths> = paths[P] extends { get: { parameters: { query?: infer T } } } ? NonNullable<T> : never;

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
const FINANCIAL_ROOTS = [
  "dashboard", "insights", "customers", "customer", "invoices", "invoice", "receivables", "receivables-summary",
  "forecast", "bills", "commitments", "audit", "payments",
];

export function invalidateFinancial(qc: QueryClient) {
  return Promise.all(FINANCIAL_ROOTS.map((root) => qc.invalidateQueries({ queryKey: [root] })));
}

// ------------------------------------------------------------------ reads
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

export function useSimulation() {
  return useMutation({
    mutationFn: (body: Schemas["SimulationRequest"]) => unwrap(api.POST("/api/v1/cashflow/simulate", { body })),
  });
}

export function useReminder() {
  return useMutation({
    mutationFn: (body: Schemas["ReminderRequest"]) => unwrap(api.POST("/api/v1/assistant/reminder", { body })),
  });
}

export function useExtract() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["ExtractRequest"]) => unwrap(api.POST("/api/v1/assistant/extract", { body })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["actions"] }),
  });
}

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
          body: reason ? { reason } : {},
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["actions"] }),
  });
}

export { newIdempotencyKey };
