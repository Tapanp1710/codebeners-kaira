/**
 * Dashboard route. A thin Server Component wrapper whose only job is to export `metadata` (page title); the
 * screen itself is the client DashboardView, which loads GET /api/v1/dashboard and the 90-day weekly
 * forecast (GET /api/v1/cashflow/forecast) through React Query. Auth is already enforced by the (app) layout.
 */
import type { Metadata } from "next";

import { DashboardView } from "@/components/dashboard/dashboard-view";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage() {
  return <DashboardView />;
}
