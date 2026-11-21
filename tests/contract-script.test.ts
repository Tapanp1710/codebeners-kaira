/**
 * scripts/contract.mjs end to end: every check runs as a real `node` process against a temporary copy of
 * the contract files (KAIRA_CONTRACT_ROOT), so drift is detected without touching the repository.
 */
// @vitest-environment node
import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = join(__dirname, "..");
let root: string;

function run(env: Record<string, string> = {}) {
  try {
    const out = execFileSync(process.execPath, [join(REPO, "scripts", "contract.mjs"), "check"], {
      env: { ...process.env, KAIRA_CONTRACT_ROOT: root, BACKEND_ORIGIN: "", ...env },
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

/** Async variant for checks that need this process's event loop free (the live-backend test serves HTTP). */
function runAsync(env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [join(REPO, "scripts", "contract.mjs"), "check"],
      { env: { ...process.env, KAIRA_CONTRACT_ROOT: root, ...env }, encoding: "utf8" },
      (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` }),
    );
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kaira-contract-test-"));
  mkdirSync(join(root, "contracts"));
  mkdirSync(join(root, "lib", "api"), { recursive: true });
  for (const f of ["contracts/openapi.json", "contracts/CONTRACT_VERSION", "lib/api/schema.d.ts"]) copyFileSync(join(REPO, f), join(root, f));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("contract check", () => {
  it("passes for the committed contract", () => {
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/OK {2}contract 1\.1\.0/);
  });

  it("fails clearly when the contract file is missing, naming the real path", () => {
    rmSync(join(root, "contracts", "openapi.json"));
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/contracts\/openapi\.json is missing/);
    expect(r.out).toMatch(/Copy the backend's docs\/openapi\.json to contracts\/openapi\.json/);
    expect(r.out).not.toMatch(/at .*contract\.mjs:\d+/); // no stack trace
  });

  it("fails when the spec was edited without re-recording (stale contract)", () => {
    const p = join(root, "contracts", "openapi.json");
    const spec = JSON.parse(readFileSync(p, "utf8"));
    spec.info.version = "9.9.9";
    writeFileSync(p, JSON.stringify(spec));
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/differs from contracts\/CONTRACT_VERSION/);
  });

  it("fails clearly on an invalid OpenAPI file", () => {
    writeFileSync(join(root, "contracts", "openapi.json"), "{ not json");
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not a valid OpenAPI JSON document/);
  });

  it("fails when the generated types do not match the contract", () => {
    writeFileSync(join(root, "lib", "api", "schema.d.ts"), "export interface paths {}\n");
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/lib\/api\/schema\.d\.ts is stale/);
  });

  describe("live backend comparison", () => {
    let server: Server;
    let origin: string;
    beforeEach(async () => {
      const spec = JSON.parse(readFileSync(join(REPO, "contracts", "openapi.json"), "utf8"));
      spec.paths["/api/v1/extra"] = { get: { responses: { "200": { description: "x" } } } };
      server = createServer((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(spec));
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const addr = server.address() as { port: number };
      origin = `http://127.0.0.1:${addr.port}`;
    });
    afterEach(() => new Promise<void>((r) => server.close(() => r())));

    it("detects a backend serving a different contract and points at the right files", async () => {
      const r = await runAsync({ BACKEND_ORIGIN: origin });
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/serves a different contract\. Copy the backend's docs\/openapi\.json to contracts\/openapi\.json/);
    });
  });
});
