"use client";

/**
 * What KAIRA is doing: one row per tool run from useAgent().activity (newest first), plus an "Understanding" row
 * while the orb is thinking. Each row shows the engine's own label, its state, the tool's summary and its result
 * fields exactly as the backend returned them; nothing here is invented or recomputed.
 */
import { AlertTriangle, CheckCircle2, CircleHelp, Loader2, Search, ShieldQuestion, Sparkles, Wrench, XCircle } from "lucide-react";
import Link from "next/link";
import type { ComponentType, SVGProps } from "react";

import { Badge, cn, type Tone } from "@/components/ui/primitives";
import type { ActivityItem, OrbState } from "@/lib/agent/protocol";
import { humanize } from "@/lib/format/dates";

export type ActivityPhase = "understanding" | "retrieving" | "executing" | "completed" | "needs_clarification" | "needs_confirmation" | "failed";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

export const ACTIVITY_PHASE: Record<ActivityPhase, { label: string; tone: Tone; icon: Icon; spin?: boolean }> = {
  understanding: { label: "Understanding", tone: "info", icon: Sparkles },
  retrieving: { label: "Retrieving", tone: "info", icon: Search },
  executing: { label: "Executing", tone: "warn", icon: Loader2, spin: true },
  completed: { label: "Completed", tone: "good", icon: CheckCircle2 },
  needs_clarification: { label: "Needs clarification", tone: "warn", icon: CircleHelp },
  needs_confirmation: { label: "Needs confirmation", tone: "warn", icon: ShieldQuestion },
  failed: { label: "Failed", tone: "danger", icon: XCircle },
};

/** Running reads are "Retrieving", running writes "Executing"; finished items keep their final state. */
export function activityPhase(item: Pick<ActivityItem, "state" | "kind">): ActivityPhase {
  if (item.state === "running") return item.kind === "write" ? "executing" : "retrieving";
  return item.state;
}

/** Primitive result fields only (objects/arrays are summarised by size), at most `max` of them. */
function resultFields(result: Record<string, unknown> | undefined, max = 8): Array<[string, string]> {
  if (!result) return [];
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(result)) {
    if (out.length >= max) break;
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out.push([k, String(v)]);
    else if (Array.isArray(v)) out.push([k, `${v.length} item${v.length === 1 ? "" : "s"}`]);
    else if (typeof v === "object") out.push([k, `${Object.keys(v as object).length} field(s)`]);
  }
  return out;
}

function duration(item: ActivityItem): string | null {
  if (!item.finished_at) return null;
  const ms = item.finished_at - item.started_at;
  if (!(ms >= 0)) return null;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function PhaseBadge({ phase }: { phase: ActivityPhase }) {
  const p = ACTIVITY_PHASE[phase];
  const Icon = p.icon;
  return (
    <Badge tone={p.tone}>
      <Icon className={cn("size-3.5", p.spin && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
      {p.label}
    </Badge>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const phase = activityPhase(item);
  const fields = resultFields(item.result);
  const took = duration(item);
  return (
    <li className="rounded-xl bg-white/60 p-3 ring-1 ring-line/80" data-testid="activity-item" data-state={item.state} data-phase={phase}>
      <div className="flex flex-wrap items-center gap-2">
        <PhaseBadge phase={phase} />
        <p className="min-w-0 flex-1 text-sm font-semibold text-ink">{item.label}</p>
        {took && <span className="text-xs text-muted">{took}</span>}
      </div>
      <p className="mt-1 flex items-center gap-1 font-mono text-[11px] text-muted">
        {item.kind === "write" ? <Wrench className="size-3" aria-hidden="true" /> : <Search className="size-3" aria-hidden="true" />}
        {item.tool} · {item.kind === "write" ? "change" : "read"}
      </p>
      {item.summary && <p className="mt-2 text-sm leading-relaxed text-ink" data-testid="activity-summary">{item.summary}</p>}
      {phase === "needs_confirmation" && (
        <p className="mt-2 text-xs text-muted">
          Say “yes” to confirm, or review it in{" "}
          <Link href="/actions" className="font-semibold text-steel underline underline-offset-2">Approvals</Link>.
        </p>
      )}
      {phase === "failed" && !item.summary && (
        <p className="mt-2 flex items-center gap-1 text-sm text-danger">
          <AlertTriangle className="size-4" aria-hidden="true" /> This step did not complete.
        </p>
      )}
      {fields.length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer font-semibold text-steel">Result details</summary>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {fields.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted">{humanize(k)}</dt>
                <dd className="num break-words text-ink">{v}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </li>
  );
}

/** Tool runs, newest first. `limit` caps the rows (the dock shows fewer). */
export function ActivityFeed({ activity, orb, limit = 20 }: { activity: ActivityItem[]; orb: OrbState; limit?: number }) {
  const items = activity.slice(-limit).reverse();
  const understanding = orb === "thinking";
  return (
    <div data-testid="agent-activity">
      {items.length === 0 && !understanding ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
          Nothing yet. When KAIRA looks something up or records a change, each step appears here with its result.
        </p>
      ) : (
        <ol className="space-y-2" aria-live="polite" aria-relevant="additions text">
          {understanding && (
            <li className="rounded-xl bg-white/60 p-3 ring-1 ring-line/80" data-testid="activity-item" data-phase="understanding">
              <div className="flex items-center gap-2">
                <PhaseBadge phase="understanding" />
                <p className="text-sm text-muted">Working out what you asked…</p>
              </div>
            </li>
          )}
          {items.map((item) => (
            <ActivityRow key={item.id} item={item} />
          ))}
        </ol>
      )}
    </div>
  );
}
