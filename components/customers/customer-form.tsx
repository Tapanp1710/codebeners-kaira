"use client";

/**
 * Create / edit customer dialog, used by app/(app)/customers/page.tsx (create, then navigate to the new
 * customer via onSaved) and app/(app)/customers/[id]/page.tsx (edit).
 *
 * Form state is react-hook-form validated by a zod schema. Saving calls:
 *   - POST  /customers       (useCreateCustomer) when no `customer` prop is given
 *   - PATCH /customers/{id}  (useUpdateCustomer) when editing
 * Both only invalidate customer queries (customer edits do not touch the ledger), and the update also
 * writes the response straight into the single-customer cache entry.
 */
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Textarea } from "@/components/ui/form";
import { Button } from "@/components/ui/primitives";
import { useToast } from "@/components/providers";
import { ApiError, describeError } from "@/lib/api/errors";
import { useCreateCustomer, useUpdateCustomer } from "@/lib/api/hooks";
import type { CustomerDetail, Schemas } from "@/lib/api/types";

// Mirrors CustomerCreate limits in the contract; the backend remains authoritative.
export const customerSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  // Optional fields accept "" because unfilled inputs submit empty strings; clean() turns them into null.
  // Phone has only a length cap: no format check is done here.
  phone: z.string().trim().max(32).optional().or(z.literal("")),
  // z.email() is the zod v4 top-level validator.
  email: z.union([z.literal(""), z.email("Enter a valid email")]).optional(),
  address: z.string().max(2000).optional().or(z.literal("")),
  notes: z.string().max(4000).optional().or(z.literal("")),
});
type Values = z.infer<typeof customerSchema>;

/**
 * Form values -> API body. Trims every field and sends blank optionals as null. On edit the same full
 * body goes to PATCH, so clearing a field explicitly sets it to null rather than leaving it unchanged.
 */
const clean = (v: Values): Schemas["CustomerCreate"] => ({
  name: v.name.trim(),
  phone: v.phone?.trim() || null,
  email: v.email?.trim() || null,
  address: v.address?.trim() || null,
  notes: v.notes?.trim() || null,
});

/**
 * @param customer when present the dialog edits this customer, otherwise it creates one
 * @param onSaved  receives the saved customer's id (the list page uses it to open the new customer)
 */
export function CustomerFormDialog({
  open,
  onClose,
  customer,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  customer?: CustomerDetail;
  onSaved?: (id: string) => void;
}) {
  const toast = useToast();
  // Both hooks are always created (rules of hooks); the "" id for create mode is never used because
  // `mutation` below picks `create` when there is no customer.
  const create = useCreateCustomer();
  const update = useUpdateCustomer(customer?.id ?? "");
  // `values` (rather than defaultValues) re-syncs the form whenever the customer prop changes, e.g.
  // after the detail query refetches.
  const form = useForm<Values>({
    resolver: zodResolver(customerSchema),
    values: {
      name: customer?.name ?? "",
      phone: customer?.phone ?? "",
      email: customer?.email ?? "",
      address: customer?.address ?? "",
      notes: customer?.notes ?? "",
    },
  });
  const mutation = customer ? update : create;
  const errors = form.formState.errors;

  async function onSubmit(values: Values) {
    try {
      const saved = await mutation.mutateAsync(clean(values));
      toast(customer ? "Customer updated" : `Customer ${saved.name} added`);
      onSaved?.(saved.id);
      onClose();
    } catch (err) {
      // Backend VALIDATION_ERROR details are mapped onto the matching inputs (by the last `loc` segment);
      // errors for unknown fields are dropped here. Any non-validation error is shown via the FormError
      // below, which reads mutation.error rather than this catch block.
      if (err instanceof ApiError) {
        for (const [field, message] of Object.entries(err.fieldErrors())) {
          if (field in values) form.setError(field as keyof Values, { message });
        }
      }
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={customer ? "Edit customer" : "New customer"}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <Field label="Name" error={errors.name?.message}>
          {(id, d) => <Input id={id} aria-describedby={d} aria-invalid={!!errors.name} autoFocus {...form.register("name")} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Phone" error={errors.phone?.message}>
            {(id, d) => <Input id={id} aria-describedby={d} inputMode="tel" {...form.register("phone")} />}
          </Field>
          <Field label="Email" error={errors.email?.message}>
            {(id, d) => <Input id={id} aria-describedby={d} aria-invalid={!!errors.email} type="email" {...form.register("email")} />}
          </Field>
        </div>
        <Field label="Address" error={errors.address?.message}>
          {(id) => <Textarea id={id} className="min-h-16" {...form.register("address")} />}
        </Field>
        <Field label="Notes" error={errors.notes?.message}>
          {(id) => <Textarea id={id} className="min-h-16" {...form.register("notes")} />}
        </Field>
        <FormError message={mutation.error && !(mutation.error instanceof ApiError && mutation.error.code === "VALIDATION_ERROR") ? describeError(mutation.error) : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>{customer ? "Save" : "Add customer"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
