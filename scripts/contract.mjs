/**
 * Keeps the frontend's copy of the backend API contract honest.
 *
 * Three artefacts must agree: contracts/openapi.json (the imported spec), lib/api/schema.d.ts
 * (TypeScript types generated from it by openapi-typescript) and contracts/CONTRACT_VERSION
 * (key=value provenance including the spec's SHA-256). `record` rewrites CONTRACT_VERSION;
 * `check` exits 1 if any pair disagrees, which blocks setup, verify and the CI checks job.
 */
// Contract integrity tool.
//   node scripts/contract.mjs record   -> writes contracts/CONTRACT_VERSION for the imported spec
//   node scripts/contract.mjs check    -> fails if (1) generated types are stale, (2) the spec changed without
//                                         re-recording, or (3) a reachable backend serves a different contract.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// All paths are resolved from the repo root so the script is independent of the working directory.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SPEC = join(ROOT, "contracts", "openapi.json");
const TYPES = join(ROOT, "lib", "api", "schema.d.ts");
const VERSION = join(ROOT, "contracts", "CONTRACT_VERSION");

// Hash after normalising CRLF -> LF so a Windows checkout (core.autocrlf) yields the same SHA as Linux CI.
const normalise = (text) => text.replace(/\r\n/g, "\n");
const sha = (text) => createHash("sha256").update(normalise(text)).digest("hex");
// Recursively sorts object keys so specs that differ only in key order compare equal (used for the live comparison).
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]))
      : value;

/** Parses CONTRACT_VERSION (one key=value per line; the value may itself contain "="). Missing file -> {}. */
function readVersion() {
  if (!existsSync(VERSION)) return {};
  return Object.fromEntries(
    readFileSync(VERSION, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

/** Runs the locally installed openapi-typescript CLI with the current Node binary (no npx, no network) and writes types to outFile. */
function generate(outFile) {
  const bin = join(ROOT, "node_modules", "openapi-typescript", "bin", "cli.js");
  execFileSync(process.execPath, [bin, SPEC, "-o", outFile], { stdio: "pipe" });
}

/** Writes CONTRACT_VERSION for the current spec. Provenance comes from env vars, else the previous record, else a default. */
function record() {
  const spec = readFileSync(SPEC, "utf8");
  const parsed = JSON.parse(spec);
  const previous = readVersion();
  const pkg = JSON.parse(readFileSync(join(ROOT, "node_modules", "openapi-typescript", "package.json"), "utf8"));
  const lines = [
    `api_version=${parsed.info.version}`,
    `backend_branch=${process.env.BACKEND_BRANCH || previous.backend_branch || "feat/kaira-backend"}`,
    `backend_commit=${process.env.BACKEND_COMMIT || previous.backend_commit || "unknown"}`,
    `openapi_sha256=${sha(spec)}`,
    `paths=${Object.keys(parsed.paths).length}`,
    `schemas=${Object.keys(parsed.components?.schemas ?? {}).length}`,
    `imported_on=${process.env.IMPORT_DATE || previous.imported_on || new Date().toISOString().slice(0, 10)}`,
    // The generator version is recorded because another openapi-typescript version can emit different types.
    `types_generator=openapi-typescript@${pkg.version}`,
  ];
  writeFileSync(VERSION, lines.join("\n") + "\n");
  console.log(`Recorded contract ${parsed.info.version} (${lines[3]})`);
}

/** Runs all consistency checks, reporting every failure before exiting. */
async function check() {
  let failed = false;
  const fail = (msg) => {
    console.error(`FAILED  ${msg}`);
    failed = true;
  };
  // Check 1: the committed spec is the one that was recorded (catches editing openapi.json without contract:generate).
  const spec = readFileSync(SPEC, "utf8");
  const version = readVersion();
  if (version.openapi_sha256 !== sha(spec)) {
    fail("contracts/openapi.json differs from contracts/CONTRACT_VERSION. Run: npm run contract:generate");
  } else console.log(`OK  contract ${version.api_version} from backend ${version.backend_commit?.slice(0, 7)}`);

  // Check 2: regenerate types into a fresh temp directory and compare with the committed file (catches stale or hand-edited types).
  const tmp = join(mkdtempSync(join(tmpdir(), "kaira-contract-")), "schema.d.ts");
  generate(tmp);
  if (!existsSync(TYPES) || normalise(readFileSync(TYPES, "utf8")) !== normalise(readFileSync(tmp, "utf8"))) {
    fail("lib/api/schema.d.ts is stale. Run: npm run contract:generate");
  } else console.log("OK  generated TypeScript types match the contract");

  // Check 3 (optional): compare with the spec the running backend serves at /openapi.json.
  const origin = process.env.BACKEND_ORIGIN;
  if (origin) {
    try {
      const res = await fetch(new URL("/openapi.json", origin), { signal: AbortSignal.timeout(5000) });
      const live = canonical(await res.json());
      const local = canonical(JSON.parse(spec));
      // info.title is ignored so a cosmetic rename on the backend does not count as contract drift.
      delete live.info?.title;
      delete local.info?.title;
      if (JSON.stringify(live) !== JSON.stringify(local)) {
        fail(`backend at ${origin} serves a different contract. Re-import docs/openapi.json from the backend.`);
      } else console.log(`OK  live backend contract at ${origin} matches`);
    } catch (err) {
      // Unreachable backend is a SKIP, not a failure: the live check is best-effort.
      console.warn(`SKIP  backend not reachable at ${origin} (${err.cause?.code ?? err.name}); live check skipped`);
    }
  } else {
    // CI's checks job sets no BACKEND_ORIGIN, so there only checks 1 and 2 gate the build.
    console.warn("SKIP  BACKEND_ORIGIN not set; live contract check skipped");
  }
  process.exit(failed ? 1 : 0);
}

// Exit codes: 0 ok, 1 check failed, 2 bad usage. Top-level await keeps the process alive until check() finishes.
const mode = process.argv[2];
if (mode === "record") record();
else if (mode === "check") await check();
else {
  console.error("usage: node scripts/contract.mjs record|check");
  process.exit(2);
}
