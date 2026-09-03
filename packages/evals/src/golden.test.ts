import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CorrectionEvent, CorrectionStore } from "@donna/core";
import { SensitiveContentError } from "@donna/memory";
import {
  ConsentRequiredError,
  EVAL_SHARING_PURPOSE,
  promoteCorrectionToGoldenCase,
  PromotionError,
} from "./golden.js";

const SCOPE = { tenantId: "tenant-alpha", userId: "user-alice" };

class MemCorrectionStore implements CorrectionStore {
  events: CorrectionEvent[] = [];
  async saveCorrection(event: CorrectionEvent): Promise<void> {
    const i = this.events.findIndex((e) => e.id === event.id);
    if (i >= 0) this.events[i] = event;
    else this.events.push(event);
  }
  async getCorrection(t: string, u: string, id: string) {
    return this.events.find(
      (e) => e.tenantId === t && e.userId === u && e.id === id,
    );
  }
  async listCorrections(t: string, u: string) {
    return this.events.filter((e) => e.tenantId === t && e.userId === u);
  }
  async deleteCorrection(t: string, u: string, id: string) {
    const before = this.events.length;
    this.events = this.events.filter(
      (e) => !(e.tenantId === t && e.userId === u && e.id === id),
    );
    return this.events.length < before;
  }
}

function acceptedCorrection(over: Partial<CorrectionEvent> = {}): CorrectionEvent {
  return {
    id: "corr-1",
    tenantId: SCOPE.tenantId,
    userId: SCOPE.userId,
    type: "bucket.move",
    createdAt: "2026-09-03T10:00:00.000Z",
    target: { kind: "thought", id: "th-1" },
    payload: {
      fromBucketId: "b-1",
      fromBucketName: "Random",
      toBucketId: "b-2",
      toBucketName: "People Ops",
      thoughtSummary: "hire a PM",
    },
    sources: [{ kind: "thought", id: "th-1", reason: "misplaced" }],
    status: "accepted",
    appliedAt: "2026-09-03T10:05:00.000Z",
    followedCount: 0,
    contradictedCount: 0,
    ...over,
  };
}

let dir: string;
let store: MemCorrectionStore;
let consented: boolean;
let datasetPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "donna-golden-"));
  datasetPath = join(dir, "corrections.v1.json");
  store = new MemCorrectionStore();
  consented = false;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps() {
  return {
    corrections: store,
    hasConsent: async (purpose: string) => purpose === EVAL_SHARING_PURPOSE && consented,
    datasetPath,
    now: () => new Date("2026-09-03T12:00:00.000Z"),
  };
}

describe("golden-case promotion (Spec 2.3 SR-1, AC-4)", () => {
  it("shares nothing by default — consent is required", async () => {
    store.events.push(acceptedCorrection());
    await assert.rejects(
      () => promoteCorrectionToGoldenCase(deps(), SCOPE, "corr-1"),
      ConsentRequiredError,
    );
    await assert.rejects(readFile(datasetPath, "utf8"), /ENOENT/);
  });

  it("promotes a de-identified case when consent is active", async () => {
    store.events.push(acceptedCorrection());
    consented = true;
    const result = await promoteCorrectionToGoldenCase(deps(), SCOPE, "corr-1");
    assert.deepEqual(result, { caseId: "corr-1", alreadyShared: false });

    const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
    assert.equal(dataset.cases.length, 1);
    const golden = dataset.cases[0];
    assert.equal(golden.id, "corr-1");
    assert.equal(golden.type, "bucket.move");
    assert.equal(golden.thoughtSummary, "hire a PM");
    assert.equal(golden.toBucketName, "People Ops");
    // De-identified: no tenant/user/capture identifiers anywhere.
    const raw = JSON.stringify(dataset);
    assert.ok(!raw.includes(SCOPE.tenantId));
    assert.ok(!raw.includes(SCOPE.userId));
    assert.ok(!raw.includes("th-1"));
    assert.ok(!raw.includes("b-1") && !raw.includes("b-2"));
    // The source correction is marked shared.
    assert.ok(store.events[0]?.sharedAt !== undefined);
  });

  it("is idempotent — re-promotion does not duplicate the case", async () => {
    store.events.push(acceptedCorrection());
    consented = true;
    await promoteCorrectionToGoldenCase(deps(), SCOPE, "corr-1");
    const again = await promoteCorrectionToGoldenCase(deps(), SCOPE, "corr-1");
    assert.equal(again.alreadyShared, true);
    const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
    assert.equal(dataset.cases.length, 1);
  });

  it("revoked consent stops further promotion", async () => {
    store.events.push(acceptedCorrection());
    store.events.push(acceptedCorrection({ id: "corr-2" }));
    consented = true;
    await promoteCorrectionToGoldenCase(deps(), SCOPE, "corr-1");
    consented = false; // revoked
    await assert.rejects(
      () => promoteCorrectionToGoldenCase(deps(), SCOPE, "corr-2"),
      ConsentRequiredError,
    );
    const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
    assert.equal(dataset.cases.length, 1);
  });

  it("refuses pending corrections and unknown IDs", async () => {
    store.events.push(acceptedCorrection({ id: "corr-p", status: "pending", appliedAt: undefined }));
    consented = true;
    await assert.rejects(
      () => promoteCorrectionToGoldenCase(deps(), SCOPE, "corr-p"),
      PromotionError,
    );
    await assert.rejects(
      () => promoteCorrectionToGoldenCase(deps(), SCOPE, "nope"),
      PromotionError,
    );
  });

  it("refuses content that fails the sensitive-content screen", async () => {
    store.events.push(
      acceptedCorrection({
        payload: {
          fromBucketName: "Random",
          toBucketName: "People Ops",
          toBucketId: "b-2",
          thoughtSummary: "reset password is hunter2 for the shared account",
        },
      }),
    );
    consented = true;
    await assert.rejects(
      () => promoteCorrectionToGoldenCase(deps(), SCOPE, "corr-1"),
      SensitiveContentError,
    );
    await assert.rejects(readFile(datasetPath, "utf8"), /ENOENT/);
  });

  it("never reads another scope's corrections", async () => {
    store.events.push(acceptedCorrection());
    consented = true;
    await assert.rejects(
      () =>
        promoteCorrectionToGoldenCase(
          deps(),
          { tenantId: "t", userId: "someone-else" },
          "corr-1",
        ),
      PromotionError,
    );
  });
});
