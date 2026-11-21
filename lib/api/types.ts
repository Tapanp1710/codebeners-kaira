/** Aliases over the generated contract types (lib/api/schema.d.ts - do not edit that file by hand). */
import type { components, paths } from "./schema";

export type { paths };
export type Schemas = components["schemas"];

export type Session = Schemas["SessionOut"];
export type Customer = Schemas["CustomerWithBalance"];
export type CustomerDetail = Schemas["CustomerDetailOut"];
export type InvoiceSummary = Schemas["InvoiceSummaryOut"];
export type Invoice = Schemas["InvoiceOut"];
export type Payment = Schemas["PaymentOut"];
export type Bill = Schemas["BillOut"];
export type Commitment = Schemas["CommitmentOut"];
export type Receivable = Schemas["ReceivableOut"];
export type ReceivablesSummary = Schemas["ReceivablesSummaryOut"];
export type Dashboard = Schemas["DashboardOut"];
export type Forecast = Schemas["ForecastOut"];
export type Simulation = Schemas["SimulationOut"];
export type Insight = Schemas["InsightOut"];
export type AuditLog = Schemas["AuditLogOut"];
export type ProposedAction = Schemas["ProposedActionOut"];
export type OperationOut = Schemas["OperationOut"];
export type Operation = Schemas["Operation"];
export type ExtractResponse = Schemas["ExtractResponse"];
export type Answer = Schemas["AnswerOut"];
export type Reminder = Schemas["ReminderOut"];
export type Transcription = Schemas["TranscriptionOut"];
export type Speech = Schemas["SpeechOut"];
export type PaymentMethod = Schemas["PaymentCreate"]["payment_method"];
export type LanguageCode = NonNullable<Schemas["ExtractRequest"]["language"]>;
export type Intent = Schemas["Operation"]["type"];
