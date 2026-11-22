"use client";

/**
 * The KAIRA orb: the visual centre of the voice-first interface (agent home: size "hero"; agent dock: "dock").
 *
 * Purely presentational. The state comes from useAgent().orb (lib/agent/protocol.ts OrbState) and the 0..1 levels
 * from useAgent().micLevel / outputLevel. Three layers:
 *   1. a CSS halo and core sphere (kaira-orb.module.css), coloured and animated per state with transforms/opacity;
 *   2. a <canvas> ring drawn with requestAnimationFrame: a distinct figure per state (still ring, spinner, audio wave,
 *      orbiting particles, scanning sweep, pulses) whose amplitude follows the microphone while listening/hearing
 *      and KAIRA's voice while speaking;
 *   3. the core is scaled by the smoothed level (style.transform, written outside React so levels never re-render).
 * prefers-reduced-motion: the canvas is drawn once per state, levels are ignored and CSS animations are off.
 * Pages render <LiveKairaOrb>, which reads the levels through useOrbLevels() (the single switchable levels source) so
 * only the orb, not the page around it, needs to follow them. KairaOrb itself is memoised and the levels reach the
 * animation loop through a ref.
 * Accessibility: role="img" with the state in its label. The visible status text is rendered by the parent from
 * ORB_STATUS (it sits in a role="status" region there), so the same words are seen and announced.
 */
import { memo, useEffect, useRef, useSyncExternalStore } from "react";

import { cn } from "@/components/ui/primitives";
import type { OrbState } from "@/lib/agent/protocol";

import { useOrbLevels } from "./orb-levels";

import styles from "./kaira-orb.module.css";

/** Visible status label and one-line hint per orb state (shared by the agent home and the dock). */
export const ORB_STATUS: Record<OrbState, { label: string; hint: string }> = {
  off: { label: "Live session off", hint: "Start the live session to talk to KAIRA, or type instead." },
  connecting: { label: "Connecting…", hint: "Opening the microphone and the voice connection." },
  listening: { label: "Listening", hint: "Microphone on. Speak whenever you are ready." },
  hearing: { label: "Hearing you", hint: "KAIRA is following what you say." },
  thinking: { label: "Understanding", hint: "Working out what you asked." },
  retrieving: { label: "Retrieving", hint: "Reading your books." },
  executing: { label: "Executing", hint: "Making the change you asked for." },
  speaking: { label: "Speaking", hint: "Use Stop speaking to interrupt." },
  muted: { label: "Muted", hint: "Microphone muted. KAIRA cannot hear you." },
  reconnecting: { label: "Reconnecting…", hint: "The voice connection dropped. Trying again." },
  error: { label: "Voice unavailable", hint: "Live voice is not working right now. You can still type." },
};

type Mode = "still" | "spin" | "wave" | "orbit" | "sweep" | "pulse";
type Figure = { mode: Mode; rgb: string; speed: number; amp: number; source?: "mic" | "out"; dashed?: boolean };

const SAGE = "169,191,169";
const CHAMPAGNE = "212,196,168";
const CREAM = "244,241,222";
const STEEL = "157,180,204";
const AMBER = "201,164,92";
const DANGER = "190,90,66";
const GREY = "120,130,140";

/** Canvas figure per state. `amp` is the wave amplitude as a fraction of the orb size, `speed` is radians/s. */
const FIGURE: Record<OrbState, Figure> = {
  off: { mode: "still", rgb: GREY, speed: 0, amp: 0 },
  connecting: { mode: "spin", rgb: CHAMPAGNE, speed: 4.2, amp: 0 },
  listening: { mode: "wave", rgb: SAGE, speed: 1.2, amp: 0.012, source: "mic" },
  hearing: { mode: "wave", rgb: SAGE, speed: 2.6, amp: 0.03, source: "mic" },
  thinking: { mode: "orbit", rgb: CHAMPAGNE, speed: 2.2, amp: 0 },
  retrieving: { mode: "sweep", rgb: STEEL, speed: 3.4, amp: 0 },
  executing: { mode: "pulse", rgb: CHAMPAGNE, speed: 0.9, amp: 0 },
  speaking: { mode: "wave", rgb: CREAM, speed: 3, amp: 0.034, source: "out" },
  muted: { mode: "still", rgb: GREY, speed: 0, amp: 0, dashed: true },
  reconnecting: { mode: "spin", rgb: AMBER, speed: 1.6, amp: 0, dashed: true },
  error: { mode: "still", rgb: DANGER, speed: 0, amp: 0 },
};

const rgba = (rgb: string, a: number) => `rgba(${rgb},${Math.max(0, Math.min(1, a)).toFixed(3)})`;

/** Draws one frame. `w` is the CSS pixel size (the context is already scaled for devicePixelRatio). */
function drawFrame(ctx: CanvasRenderingContext2D, w: number, t: number, fig: Figure, level: number, compact: boolean) {
  const c = w / 2;
  const R = w * (compact ? 0.42 : 0.36);
  const lw = Math.max(1, w * (compact ? 0.04 : 0.008));
  ctx.clearRect(0, 0, w, w);
  ctx.lineCap = "round";

  const ring = (r: number, alpha: number, width = lw, dashed = false) => {
    ctx.beginPath();
    ctx.setLineDash(dashed ? [w * 0.03, w * 0.035] : []);
    ctx.strokeStyle = rgba(fig.rgb, alpha);
    ctx.lineWidth = width;
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  };
  const arc = (r: number, from: number, to: number, alpha: number, width = lw * 1.6) => {
    ctx.beginPath();
    ctx.strokeStyle = rgba(fig.rgb, alpha);
    ctx.lineWidth = width;
    ctx.arc(c, c, r, from, to);
    ctx.stroke();
  };
  const dot = (angle: number, r: number, size: number, alpha: number) => {
    ctx.beginPath();
    ctx.fillStyle = rgba(fig.rgb, alpha);
    ctx.arc(c + Math.cos(angle) * r, c + Math.sin(angle) * r, size, 0, Math.PI * 2);
    ctx.fill();
  };

  switch (fig.mode) {
    case "still":
      ring(R, fig.dashed ? 0.45 : 0.35, lw, fig.dashed);
      break;
    case "spin": {
      ring(R, 0.12, lw, fig.dashed);
      const a = t * fig.speed;
      arc(R, a, a + Math.PI * 0.55, 0.9);
      if (!compact) arc(R, a + Math.PI, a + Math.PI * 1.3, 0.4);
      break;
    }
    case "wave": {
      const layers = compact ? 1 : 3;
      const steps = compact ? 48 : 180;
      const amp = w * fig.amp * (0.35 + level * 2.2);
      for (let k = 0; k < layers; k++) {
        ctx.beginPath();
        for (let i = 0; i <= steps; i++) {
          const th = (i / steps) * Math.PI * 2;
          const wobble =
            Math.sin(3 * th + t * fig.speed * (1 + k * 0.3) + k * 2) * 0.6 + Math.sin(5 * th - t * fig.speed * 0.7 + k) * 0.4;
          const r = R + amp * wobble * (1 - k * 0.2);
          const x = c + Math.cos(th) * r;
          const y = c + Math.sin(th) * r;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.strokeStyle = rgba(fig.rgb, 0.75 - k * 0.22);
        ctx.lineWidth = lw * (k === 0 ? 1.4 : 1);
        ctx.stroke();
      }
      break;
    }
    case "orbit": {
      ring(R, 0.14);
      const count = compact ? 2 : 3;
      for (let i = 0; i < count; i++) {
        const a = t * fig.speed * (1 + i * 0.35) + i * 2.1;
        const r = R * (1 + 0.06 * Math.sin(t * 1.3 + i));
        for (let s = 0; s < 8; s++) arc(r, a - (s + 1) * 0.09, a - s * 0.09, (1 - s / 8) * 0.6, lw * 1.2);
        dot(a, r, Math.max(1.2, w * (compact ? 0.05 : 0.012)), 0.95);
      }
      break;
    }
    case "sweep": {
      ring(R, 0.16);
      const a = t * fig.speed;
      for (let s = 0; s < 14; s++) arc(R, a - (s + 1) * 0.07, a - s * 0.07, (1 - s / 14) * 0.85, lw * 1.8);
      if (!compact) {
        for (let i = 0; i < 6; i++) {
          const p = (t * 0.6 + i / 6) % 1;
          dot(i * 1.047 + 0.4, R * 1.28 - p * R * 0.32, w * 0.008, (1 - p) * 0.7);
        }
      }
      break;
    }
    case "pulse": {
      for (let i = 0; i < 3; i++) {
        const p = (t * fig.speed + i / 3) % 1;
        ring(R * (1 + p * (compact ? 0.15 : 0.32)), (1 - p) * 0.7, lw * (1.6 - p));
      }
      break;
    }
  }
}

function subscribeReducedMotion(onChange: () => void) {
  const mq = typeof window !== "undefined" ? window.matchMedia?.("(prefers-reduced-motion: reduce)") : undefined;
  mq?.addEventListener?.("change", onChange);
  return () => mq?.removeEventListener?.("change", onChange);
}
const getReducedMotion = () =>
  typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);

/** True when the user asked the OS/browser to reduce motion. Server render assumes motion is allowed. */
export function usePrefersReducedMotion() {
  return useSyncExternalStore(subscribeReducedMotion, getReducedMotion, () => false);
}

export type KairaOrbProps = {
  state: OrbState;
  /** 0..1 microphone level (drives the ring while listening/hearing). */
  micLevel: number;
  /** 0..1 playback level (drives the ring while speaking). */
  outputLevel: number;
  size: "hero" | "dock";
  className?: string;
};

export const KairaOrb = memo(function KairaOrb({ state, micLevel, outputLevel, size, className }: KairaOrbProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const coreRef = useRef<HTMLSpanElement>(null);
  const levels = useRef({ mic: 0, out: 0 });
  const reduced = usePrefersReducedMotion();

  // Levels change many times a second; the animation loop reads them from a ref instead of restarting.
  useEffect(() => {
    levels.current = { mic: micLevel, out: outputLevel };
  }, [micLevel, outputLevel]);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      ctx = null;
    }
    if (!ctx) return;
    const fig = FIGURE[state];
    const compact = size === "dock";
    let width = 0;
    let frame = 0;
    let smooth = 0;
    const start = performance.now();

    const resize = () => {
      const w = root.clientWidth;
      if (!w || w === width) return;
      width = w;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(w * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
      resize();
      if (reduced) drawFrame(ctx!, width, 0, fig, 0, compact);
    }) : null;
    ro?.observe(root);

    if (reduced) {
      // One still frame per state; no loop, no level-driven motion.
      if (coreRef.current) coreRef.current.style.transform = "";
      drawFrame(ctx, width, 0, fig, 0, compact);
      return () => ro?.disconnect();
    }

    const loop = (now: number) => {
      const target = fig.source === "mic" ? levels.current.mic : fig.source === "out" ? levels.current.out : 0;
      smooth += (Math.max(0, Math.min(1, target)) - smooth) * 0.18;
      if (width) drawFrame(ctx!, width, (now - start) / 1000, fig, smooth, compact);
      if (coreRef.current) coreRef.current.style.transform = `scale(${(1 + smooth * 0.08).toFixed(4)})`;
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      ro?.disconnect();
    };
  }, [state, size, reduced]);

  return (
    <div
      ref={rootRef}
      role="img"
      aria-label={`KAIRA: ${ORB_STATUS[state].label}`}
      data-state={state}
      data-size={size}
      data-testid="kaira-orb"
      className={cn(styles.orb, size === "hero" ? styles.hero : styles.dock, className)}
    >
      <span className={styles.halo} aria-hidden="true" />
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
      <span ref={coreRef} className={styles.core} aria-hidden="true">
        <span className={styles.sheen} />
      </span>
    </div>
  );
});

/** The orb wired to the live session's audio levels (see orb-levels.ts). Use this on pages. */
export const LiveKairaOrb = memo(function LiveKairaOrb(props: Omit<KairaOrbProps, "micLevel" | "outputLevel">) {
  const { micLevel, outputLevel } = useOrbLevels();
  return <KairaOrb {...props} micLevel={micLevel} outputLevel={outputLevel} />;
});
