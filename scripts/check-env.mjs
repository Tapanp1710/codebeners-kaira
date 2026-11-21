// Validates frontend configuration and (optionally) backend connectivity.
//   node scripts/check-env.mjs            -> validate .env.local (fails on errors)
//   node scripts/check-env.mjs --connect  -> also call BACKEND_ORIGIN/api/v1/health and /ready
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const file = join(ROOT, ".env.local");
const env = { ...readEnv(file), ...pick(process.env, ["BACKEND_ORIGIN", "BACKEND_TIMEOUT_MS"]) };
let failed = false;
const ok = (m) => console.log(`OK    ${m}`);
const warn = (m) => console.log(`WARN  ${m}`);
const fail = (m) => {
  console.log(`FAIL  ${m}`);
  failed = true;
};

function readEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => obj[k]).map((k) => [k, obj[k]]));
}

if (!existsSync(file)) warn(".env.local not found (copy .env.example; scripts/setup does this).");

const origin = env.BACKEND_ORIGIN;
if (!origin) fail("BACKEND_ORIGIN is not set. It is the server-side address of the KAIRA backend, e.g. http://127.0.0.1:8000");
else {
  try {
    const u = new URL(origin);
    if (!["http:", "https:"].includes(u.protocol)) fail("BACKEND_ORIGIN must start with http:// or https://");
    else if (u.pathname !== "/" ) fail(`BACKEND_ORIGIN must be an origin only (no path such as ${u.pathname}). Use ${u.origin}`);
    else ok(`BACKEND_ORIGIN = ${u.origin} (server-side only, never sent to the browser)`);
    if (u.protocol === "http:" && !["127.0.0.1", "localhost"].includes(u.hostname) && !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname)) {
      warn("BACKEND_ORIGIN uses plain http to a non-private host. Use https for anything beyond a private network.");
    }
  } catch {
    fail(`BACKEND_ORIGIN is not a valid URL: ${origin}`);
  }
}

for (const [k, v] of Object.entries(env)) {
  if (k.startsWith("NEXT_PUBLIC_") && /(SECRET|KEY|TOKEN|PASSWORD|DATABASE|SARVAM)/.test(k)) {
    fail(`${k} looks like a secret but NEXT_PUBLIC_ variables are sent to every browser. Remove it.`);
  }
  if (/^(SARVAM_API_KEY|DATABASE_URL|JWT_SECRET_KEY)$/.test(k) && v) {
    fail(`${k} belongs to the backend only. Remove it from the frontend environment.`);
  }
}

if (process.argv.includes("--connect") && origin && !failed) {
  try {
    const res = await fetch(new URL("/api/v1/health", origin), { signal: AbortSignal.timeout(5000) });
    if (res.ok) ok(`Backend reachable at ${origin} (HTTP ${res.status})`);
    else warn(`Backend answered HTTP ${res.status} at ${origin}/api/v1/health`);
    const ready = await fetch(new URL("/api/v1/ready", origin), { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => null);
    const checks = ready?.data?.checks ?? ready?.error?.details?.checks;
    if (checks) {
      ok(`Backend readiness: database=${checks.database}, migrations=${checks.migrations}, voice=${checks.voice_provider}`);
      if (checks.voice_provider !== "configured") warn("Voice (Sarvam) is not configured on the backend: voice input and Telugu/Hindi will show as unavailable.");
    }
  } catch (err) {
    warn(`Backend NOT reachable at ${origin} (${err.cause?.code ?? err.name}). Start it, or fix BACKEND_ORIGIN / firewall. The UI will show a connectivity error until then.`);
  }
}

process.exit(failed ? 1 : 0);
