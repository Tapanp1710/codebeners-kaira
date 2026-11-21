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

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SPEC = join(ROOT, "contracts", "openapi.json");
const TYPES = join(ROOT, "lib", "api", "schema.d.ts");
const VERSION = join(ROOT, "contracts", "CONTRACT_VERSION");

const normalise = (text) => text.replace(/\r\n/g, "\n");
const sha = (text) => createHash("sha256").update(normalise(text)).digest("hex");
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]))
      : value;

function readVersion() {
  if (!existsSync(VERSION)) return {};
  return Object.fromEntries(
    readFileSync(VERSION, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

function generate(outFile) {
  const bin = join(ROOT, "node_modules", "openapi-typescript", "bin", "cli.js");
  execFileSync(process.execPath, [bin, SPEC, "-o", outFile], { stdio: "pipe" });
}

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
    `types_generator=openapi-typescript@${pkg.version}`,
  ];
  writeFileSync(VERSION, lines.join("\n") + "\n");
  console.log(`Recorded contract ${parsed.info.version} (${lines[3]})`);
}

async function check() {
  let failed = false;
  const fail = (msg) => {
    console.error(`FAILED  ${msg}`);
    failed = true;
  };
  const spec = readFileSync(SPEC, "utf8");
  const version = readVersion();
  if (version.openapi_sha256 !== sha(spec)) {
    fail("contracts/openapi.json differs from contracts/CONTRACT_VERSION. Run: npm run contract:generate");
  } else console.log(`OK  contract ${version.api_version} from backend ${version.backend_commit?.slice(0, 7)}`);

  const tmp = join(mkdtempSync(join(tmpdir(), "kaira-contract-")), "schema.d.ts");
  generate(tmp);
  if (!existsSync(TYPES) || normalise(readFileSync(TYPES, "utf8")) !== normalise(readFileSync(tmp, "utf8"))) {
    fail("lib/api/schema.d.ts is stale. Run: npm run contract:generate");
  } else console.log("OK  generated TypeScript types match the contract");

  const origin = process.env.BACKEND_ORIGIN;
  if (origin) {
    try {
      const res = await fetch(new URL("/openapi.json", origin), { signal: AbortSignal.timeout(5000) });
      const live = canonical(await res.json());
      const local = canonical(JSON.parse(spec));
      delete live.info?.title;
      delete local.info?.title;
      if (JSON.stringify(live) !== JSON.stringify(local)) {
        fail(`backend at ${origin} serves a different contract. Re-import docs/openapi.json from the backend.`);
      } else console.log(`OK  live backend contract at ${origin} matches`);
    } catch (err) {
      console.warn(`SKIP  backend not reachable at ${origin} (${err.cause?.code ?? err.name}); live check skipped`);
    }
  } else {
    console.warn("SKIP  BACKEND_ORIGIN not set; live contract check skipped");
  }
  process.exit(failed ? 1 : 0);
}

const mode = process.argv[2];
if (mode === "record") record();
else if (mode === "check") await check();
else {
  console.error("usage: node scripts/contract.mjs record|check");
  process.exit(2);
}
