import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCompatibilityCheck } from "./compatibility.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const CONFIG_PATH = join(repoRoot, "models.config.yaml");
const FIXED_NOW = new Date("2026-09-02T12:00:00.000Z");

const CONFIGURED_ENV = {
  TRUEFOUNDRY_BASE_URL: "https://canary-host.internal.example.co/api/llm",
  TRUEFOUNDRY_API_KEY: "tfy-canary-secret-value-12345",
};

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "donna-compat-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("runCompatibilityCheck", () => {
  it("reports blocked with exact missing prerequisites when nothing is set", async () => {
    await withTempDir(async (dir) => {
      const { report, reportPath } = await runCompatibilityCheck({
        configPath: CONFIG_PATH,
        reportsDir: dir,
        env: {},
        now: () => FIXED_NOW,
      });
      assert.equal(report.status, "blocked");
      assert.ok(
        report.missingPrerequisites.some((p) =>
          p.includes("TRUEFOUNDRY_BASE_URL"),
        ),
      );
      assert.ok(
        report.missingPrerequisites.some((p) =>
          p.includes("TRUEFOUNDRY_API_KEY"),
        ),
      );
      assert.ok(
        report.missingPrerequisites.some((p) =>
          p.includes("reference recording"),
        ),
      );
      assert.equal(report.checks.referenceAudio, "not-provided");
      // Stages are enumerated from config but never run.
      assert.equal(report.stages.length, 4);
      assert.ok(report.stages.every((s) => s.status === "not-run"));
      assert.ok(
        report.stages.every((s) => s.reason === "missing-prerequisites"),
      );
      // The embed stage records its expected 1024 dimensions.
      const embed = report.stages.find((s) => s.stage === "embed");
      assert.equal(embed?.expectedDimensions, 1024);
      // Report file exists and parses back to the same payload.
      const written = JSON.parse(await readFile(reportPath, "utf8"));
      assert.deepEqual(written, JSON.parse(JSON.stringify(report)));
    });
  });

  it("calls out placeholder credentials distinctly from unset ones", async () => {
    await withTempDir(async (dir) => {
      const { report } = await runCompatibilityCheck({
        configPath: CONFIG_PATH,
        reportsDir: dir,
        env: {
          TRUEFOUNDRY_BASE_URL:
            "https://your-gateway.truefoundry.cloud/api/llm",
          TRUEFOUNDRY_API_KEY: "replace-me",
        },
        now: () => FIXED_NOW,
      });
      assert.equal(report.status, "blocked");
      assert.equal(report.checks.gatewayBaseUrl, "placeholder");
      assert.equal(report.checks.gatewayApiKey, "placeholder");
      assert.ok(
        report.missingPrerequisites.every((p) => !p.includes("replace-me")),
      );
    });
  });

  it("blocks on a missing recording even when credentials are configured", async () => {
    await withTempDir(async (dir) => {
      const { report } = await runCompatibilityCheck({
        audioPath: join(dir, "does-not-exist.m4a"),
        configPath: CONFIG_PATH,
        reportsDir: dir,
        env: CONFIGURED_ENV,
        now: () => FIXED_NOW,
      });
      assert.equal(report.status, "blocked");
      assert.deepEqual(report.missingPrerequisites, [
        "reference recording does not exist",
      ]);
    });
  });

  it("reports ready-for-live-run when every prerequisite holds", async () => {
    await withTempDir(async (dir) => {
      const audio = join(dir, "reference.m4a");
      await writeFile(audio, Buffer.from([1, 2, 3, 4]));
      const { report } = await runCompatibilityCheck({
        audioPath: audio,
        configPath: CONFIG_PATH,
        reportsDir: dir,
        env: CONFIGURED_ENV,
        now: () => FIXED_NOW,
      });
      assert.equal(report.status, "ready-for-live-run");
      assert.deepEqual(report.missingPrerequisites, []);
      assert.ok(
        report.stages.every((s) => s.reason === "awaiting-live-run"),
      );
    });
  });

  it("never writes credential values or audio paths into the report", async () => {
    await withTempDir(async (dir) => {
      const audio = join(dir, "reference.m4a");
      await writeFile(audio, Buffer.from([1, 2, 3, 4]));
      const { reportPath } = await runCompatibilityCheck({
        audioPath: audio,
        configPath: CONFIG_PATH,
        reportsDir: dir,
        env: CONFIGURED_ENV,
        now: () => FIXED_NOW,
      });
      const raw = await readFile(reportPath, "utf8");
      assert.ok(!raw.includes(CONFIGURED_ENV.TRUEFOUNDRY_API_KEY));
      assert.ok(!raw.includes(CONFIGURED_ENV.TRUEFOUNDRY_BASE_URL));
      assert.ok(!raw.includes("canary-host"));
      assert.ok(!raw.includes(audio));
      assert.ok(!raw.includes(dir));
    });
  });

  it("records a models-config parse failure as a blocker", async () => {
    await withTempDir(async (dir) => {
      const badConfig = join(dir, "models.config.yaml");
      await writeFile(badConfig, "version: nope\n");
      const { report } = await runCompatibilityCheck({
        configPath: badConfig,
        reportsDir: dir,
        env: CONFIGURED_ENV,
        now: () => FIXED_NOW,
      });
      assert.equal(report.status, "blocked");
      assert.equal(report.checks.modelsConfig, "error");
      assert.ok(
        report.missingPrerequisites.some((p) =>
          p.includes("models.config.yaml"),
        ),
      );
    });
  });
});
