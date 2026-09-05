/**
 * Specification 6.1 tests: pilot onboarding, per-setting consent, source
 * revoke, export, exit/deletion, excluded-category rejection, redaction
 * defaults, and the durable-memory gate.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type {
  ConsentRecord,
  ConsentStore,
  MemoryEvent,
  MemoryProposal,
  MemoryRecord,
  MemoryStore,
} from "@donna/core";
import {
  DurableMemoryDisabledError,
  MemoryService,
} from "@donna/memory";
import {
  EMOTION_PERSIST_PURPOSE,
  EnrollmentError,
  ExcludedCategoryError,
  NotEnrolledError,
  PilotService,
  UnknownDataClassError,
  pilotDataClassPurpose,
  pilotRedactionActive,
  redactContent,
  validatePilotDataClasses,
  PILOT_AUDIO_RETENTION_PURPOSE,
  PILOT_CONSENT_TEXT_VERSION,
  PILOT_DURABLE_MEMORY_PURPOSE,
  PILOT_ENROLL_PURPOSE,
  type EnrollmentDecisions,
  type PilotProfile,
  type PilotProfileStore,
} from "./index.js";
import { MisfireRegister, type MisfireRegisterStore, type MisfireRecord } from "./index.js";

/* --------------------------- in-memory stores ------------------------- */

class MemStore implements MemoryStore {
  memories: MemoryRecord[] = [];
  proposals: MemoryProposal[] = [];
  events: MemoryEvent[] = [];
  async saveMemory(record: MemoryRecord): Promise<void> {
    const i = this.memories.findIndex((m) => m.id === record.id);
    if (i >= 0) this.memories[i] = record;
    else this.memories.push(record);
  }
  async getMemory(t: string, u: string, id: string): Promise<MemoryRecord | undefined> {
    return this.memories.find((m) => m.tenantId === t && m.userId === u && m.id === id);
  }
  async listMemories(t: string, u: string): Promise<MemoryRecord[]> {
    return this.memories.filter((m) => m.tenantId === t && m.userId === u);
  }
  async deleteMemory(t: string, u: string, id: string): Promise<boolean> {
    const before = this.memories.length;
    this.memories = this.memories.filter((m) => !(m.tenantId === t && m.userId === u && m.id === id));
    return this.memories.length < before;
  }
  async saveProposal(proposal: MemoryProposal): Promise<void> {
    const i = this.proposals.findIndex((p) => p.id === proposal.id);
    if (i >= 0) this.proposals[i] = proposal;
    else this.proposals.push(proposal);
  }
  async getProposal(t: string, u: string, id: string): Promise<MemoryProposal | undefined> {
    return this.proposals.find((p) => p.tenantId === t && p.userId === u && p.id === id);
  }
  async listProposals(t: string, u: string): Promise<MemoryProposal[]> {
    return this.proposals.filter((p) => p.tenantId === t && p.userId === u);
  }
  async deleteProposal(t: string, u: string, id: string): Promise<boolean> {
    const before = this.proposals.length;
    this.proposals = this.proposals.filter((p) => !(p.tenantId === t && p.userId === u && p.id === id));
    return this.proposals.length < before;
  }
  async appendEvent(event: MemoryEvent): Promise<void> {
    this.events.push(event);
  }
  async listEvents(t: string, u: string): Promise<MemoryEvent[]> {
    return this.events.filter((e) => e.tenantId === t && e.userId === u);
  }
}

class MemConsents implements ConsentStore {
  records: ConsentRecord[] = [];
  async recordConsent(record: ConsentRecord): Promise<void> {
    this.records.push(record);
  }
  async listConsents(t: string, u: string): Promise<ConsentRecord[]> {
    return this.records.filter((r) => r.tenantId === t && r.userId === u);
  }
}

class MemProfiles implements PilotProfileStore {
  profiles: PilotProfile[] = [];
  async get(t: string, u: string): Promise<PilotProfile | undefined> {
    return this.profiles.find((p) => p.tenantId === t && p.userId === u);
  }
  async save(profile: PilotProfile): Promise<void> {
    const i = this.profiles.findIndex(
      (p) => p.tenantId === profile.tenantId && p.userId === profile.userId,
    );
    if (i >= 0) this.profiles[i] = profile;
    else this.profiles.push(profile);
  }
}

class MemMisfires implements MisfireRegisterStore {
  records: MisfireRecord[] = [];
  async list(t: string, u: string): Promise<MisfireRecord[]> {
    return this.records.filter((r) => r.tenantId === t && r.userId === u);
  }
  async saveAll(t: string, u: string, records: MisfireRecord[]): Promise<void> {
    this.records = [...this.records.filter((r) => !(r.tenantId === t && r.userId === u)), ...records];
  }
}

/* ------------------------------- fixture ------------------------------ */

const SCOPE = { tenantId: "t", userId: "u" };

function decisions(overrides: Partial<EnrollmentDecisions> = {}): EnrollmentDecisions {
  return {
    participantId: "P-01",
    dataClasses: ["meetings", "tasks"],
    m365Sources: [],
    durableMemory: true,
    emotionInference: true,
    emotionPersistence: false,
    acknowledgements: { explanations: true, audioRetention: true, notAuthoritative: true },
    ...overrides,
  };
}

let now: Date;
let profiles: MemProfiles;
let consents: MemConsents;
let memoryStore: MemStore;
let memory: MemoryService;
let service: PilotService;
let idCounter: number;

beforeEach(() => {
  now = new Date("2026-09-03T12:00:00.000Z");
  profiles = new MemProfiles();
  consents = new MemConsents();
  memoryStore = new MemStore();
  idCounter = 0;
  const idGen = () => `id-${++idCounter}`;
  memory = new MemoryService({ memories: memoryStore, consents, now: () => now, idGen });
  service = new PilotService({ profiles, memory, now: () => now, idGen });
});

/* -------------------------------- tests ------------------------------- */

describe("pilot onboarding (Spec 6.1)", () => {
  it("AC-1/FR-1: fresh onboarding writes the profile and versioned consent records", async () => {
    const profile = await service.enroll(SCOPE, decisions());
    assert.equal(profile.status, "enrolled");
    assert.equal(profile.participantId, "P-01");
    assert.equal(profile.audioRetentionDays, 7);
    assert.equal(profile.emotionPersistence, false);
    assert.deepEqual(profile.m365Sources, []);
    assert.equal(profile.consentTextVersion, PILOT_CONSENT_TEXT_VERSION);

    const purposes = consents.records.map((r) => `${r.purpose}:${r.granted}`);
    assert.ok(purposes.includes(`${PILOT_ENROLL_PURPOSE}:true`));
    assert.ok(purposes.includes(`${PILOT_AUDIO_RETENTION_PURPOSE}:true`));
    assert.ok(purposes.includes(`${pilotDataClassPurpose("meetings")}:true`));
    assert.ok(purposes.includes(`${pilotDataClassPurpose("tasks")}:true`));
    assert.ok(purposes.includes(`${PILOT_DURABLE_MEMORY_PURPOSE}:true`));
    // Narrow defaults are explicit denials, not absences.
    assert.ok(purposes.includes("m365.read.calendar:false"));
    assert.ok(purposes.includes("m365.read.mail:false"));
    assert.ok(purposes.includes("m365.read.teams:false"));
    assert.ok(purposes.includes("m365.read.files:false"));
    assert.ok(purposes.includes(`${EMOTION_PERSIST_PURPOSE}:false`));
    // Every record carries the consent-text version in its channel.
    for (const record of consents.records) {
      assert.equal(record.channel, `pilot-onboard:${PILOT_CONSENT_TEXT_VERSION}`);
    }
    // Effective state matches the narrow default.
    assert.equal(await memory.hasConsent(SCOPE, "m365.read.mail"), false);
    assert.equal(await memory.hasConsent(SCOPE, PILOT_ENROLL_PURPOSE), true);
  });

  it("onboarding with chosen sources grants exactly those read consents", async () => {
    await service.enroll(SCOPE, decisions({ m365Sources: ["calendar", "files"] }));
    assert.equal(await memory.hasConsent(SCOPE, "m365.read.calendar"), true);
    assert.equal(await memory.hasConsent(SCOPE, "m365.read.files"), true);
    assert.equal(await memory.hasConsent(SCOPE, "m365.read.mail"), false);
    assert.equal(await memory.hasConsent(SCOPE, "m365.read.teams"), false);
  });

  it("FR-1: enrollment refuses without every affirmative acknowledgement", async () => {
    await assert.rejects(
      service.enroll(
        SCOPE,
        decisions({
          acknowledgements: { explanations: true, audioRetention: false, notAuthoritative: true },
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof EnrollmentError);
        assert.match(error.message, /audioRetention/);
        return true;
      },
    );
    assert.equal(await profiles.get(SCOPE.tenantId, SCOPE.userId), undefined);
    assert.equal(consents.records.length, 0);
  });

  it("rejects non-pseudonymous participant IDs (never a name or email)", async () => {
    await assert.rejects(
      service.enroll(SCOPE, decisions({ participantId: "raj@example.com" })),
      /pseudonymous/,
    );
    await assert.rejects(
      service.enroll(SCOPE, decisions({ participantId: "x" })),
      /pseudonymous/,
    );
  });

  it("rejects duplicate enrollment while enrolled", async () => {
    await service.enroll(SCOPE, decisions());
    await assert.rejects(service.enroll(SCOPE, decisions()), /Already enrolled/);
  });

  it("SR-3: excluded sensitive categories are rejected with a clear message", async () => {
    for (const input of ["hr", "Human Resources", "legal", "financial", "KYC", "payment-processing", "payroll"]) {
      await assert.rejects(
        service.enroll(SCOPE, decisions({ dataClasses: ["meetings", input] })),
        (error: unknown) => {
          assert.ok(error instanceof ExcludedCategoryError, `expected ExcludedCategoryError for ${input}`);
          assert.match(error.message, /excludes HR, legal, financial, KYC, and payment/);
          return true;
        },
      );
    }
    // Non-excluded words that merely contain a token substring are NOT
    // flagged as excluded (they are simply unknown classes).
    assert.throws(() => validatePilotDataClasses(["legalize-meeting-notes"]), UnknownDataClassError);
  });

  it("unknown data classes are rejected listing the permitted set", async () => {
    await assert.rejects(
      service.enroll(SCOPE, decisions({ dataClasses: ["meetings", "gardening"] })),
      (error: unknown) => {
        assert.ok(error instanceof UnknownDataClassError);
        assert.match(error.message, /gardening/);
        assert.match(error.message, /meetings/);
        return true;
      },
    );
  });

  it("emotion persistence requires emotion inference", async () => {
    await assert.rejects(
      service.enroll(SCOPE, decisions({ emotionInference: false, emotionPersistence: true })),
      /requires session emotion inference/,
    );
  });

  it("FR-2: per-setting opt-in/opt-out re-records consent", async () => {
    await service.enroll(SCOPE, decisions({ durableMemory: true }));
    let profile = await service.setDurableMemory(SCOPE, false);
    assert.equal(profile.durableMemory, false);
    assert.equal(await memory.hasConsent(SCOPE, PILOT_DURABLE_MEMORY_PURPOSE), false);
    const durableRecords = consents.records.filter((r) => r.purpose === PILOT_DURABLE_MEMORY_PURPOSE);
    const denial = durableRecords[durableRecords.length - 1];
    assert.equal(denial?.granted, false);
    assert.equal(denial?.channel, `pilot-set:${PILOT_CONSENT_TEXT_VERSION}`);

    profile = await service.setDurableMemory(SCOPE, true);
    assert.equal(await memory.hasConsent(SCOPE, PILOT_DURABLE_MEMORY_PURPOSE), true);

    // Emotion persistence on/off.
    await service.setEmotionPersistence(SCOPE, true);
    assert.equal(await memory.hasConsent(SCOPE, EMOTION_PERSIST_PURPOSE), true);
    const p1 = await service.getProfile(SCOPE);
    assert.equal(p1?.emotionPersistence, true);
    await service.setEmotionPersistence(SCOPE, false);
    assert.equal(await memory.hasConsent(SCOPE, EMOTION_PERSIST_PURPOSE), false);

    // Turning inference off ends persistence too.
    await service.setEmotionPersistence(SCOPE, true);
    const off = await service.setEmotionInference(SCOPE, false);
    assert.equal(off.emotionInference, false);
    assert.equal(off.emotionPersistence, false);
    assert.equal(await memory.hasConsent(SCOPE, EMOTION_PERSIST_PURPOSE), false);
  });

  it("FR-2/AC-2: data-class changes grant new and revoke removed", async () => {
    await service.enroll(SCOPE, decisions({ dataClasses: ["meetings", "tasks"] }));
    const result = await service.updateDataClasses(SCOPE, ["tasks", "ideas"]);
    assert.deepEqual(result.granted, ["ideas"]);
    assert.deepEqual(result.revoked, ["meetings"]);
    assert.equal(await memory.hasConsent(SCOPE, pilotDataClassPurpose("meetings")), false);
    assert.equal(await memory.hasConsent(SCOPE, pilotDataClassPurpose("ideas")), true);
    assert.deepEqual(result.profile.dataClasses, ["tasks", "ideas"]);
    // Excluded categories rejected here too.
    await assert.rejects(service.updateDataClasses(SCOPE, ["tasks", "hr"]), ExcludedCategoryError);
  });

  it("AC-2: Microsoft source revoke stops the consent gate", async () => {
    await service.enroll(SCOPE, decisions({ m365Sources: ["calendar", "mail"] }));
    assert.equal(await memory.hasConsent(SCOPE, "m365.read.mail"), true);
    const result = await service.updateM365Sources(SCOPE, ["calendar"]);
    assert.deepEqual(result.revoked, ["mail"]);
    assert.equal(await memory.hasConsent(SCOPE, "m365.read.mail"), false);
    assert.equal(await memory.hasConsent(SCOPE, "m365.read.calendar"), true);
    assert.deepEqual(result.profile.m365Sources, ["calendar"]);
  });

  it("FR-3/AC-2: export bundles profile, consents, memories, captures, corrections, misfires", async () => {
    await service.enroll(SCOPE, decisions());
    await memory.stateExplicit(SCOPE, {
      layer: "semantic",
      kind: "preference",
      subject: "preference:summary-style",
      text: "Prefers short bullet summaries",
      sources: [{ kind: "explicit-statement", id: "cli-1", reason: "user said so" }],
    });
    const bundle = await service.exportBundle(SCOPE, {
      captures: [
        {
          id: "cap-1",
          tenantId: "t",
          userId: "u",
          contentHash: "abc",
          capturedAt: "2026-09-03T11:00:00.000Z",
        },
      ],
      corrections: [],
      misfires: [],
    });
    assert.equal(bundle.schema, "donna.pilot-export.v1");
    assert.equal(bundle.participantId, "P-01");
    assert.equal(bundle.memory.memories.length, 1);
    assert.ok(bundle.memory.consents.length > 0);
    assert.equal(bundle.captures.length, 1);
    assert.equal(bundle.profile.status, "enrolled");
  });

  it("FR-3/AC-2: exit revokes every active consent and marks the profile exited", async () => {
    await service.enroll(SCOPE, decisions({ m365Sources: ["calendar"], emotionPersistence: true }));
    await memory.grantConsent(SCOPE, "eval-sharing", "cli:consent grant");
    const { profile, revokedPurposes } = await service.exit(SCOPE);
    assert.equal(profile.status, "exited");
    assert.ok(profile.exitedAt !== undefined);
    for (const purpose of [
      PILOT_ENROLL_PURPOSE,
      "m365.read.calendar",
      EMOTION_PERSIST_PURPOSE,
      "eval-sharing",
    ]) {
      assert.ok(revokedPurposes.includes(purpose), `expected ${purpose} revoked`);
      assert.equal(await memory.hasConsent(SCOPE, purpose), false);
    }
    // History is preserved (grant + revoke both present).
    const enrollHistory = consents.records.filter((r) => r.purpose === PILOT_ENROLL_PURPOSE);
    assert.equal(enrollHistory.filter((r) => r.granted).length, 1);
    assert.equal(enrollHistory.filter((r) => !r.granted).length, 1);
    // An exited profile is not enrolled; re-enrollment is possible.
    await assert.rejects(service.exportBundle(SCOPE), NotEnrolledError);
    await service.enroll(SCOPE, decisions({ participantId: "P-01" }));
    assert.equal((await service.getProfile(SCOPE))?.status, "enrolled");
  });

  it("settings changes refuse when not enrolled", async () => {
    await assert.rejects(service.setDurableMemory(SCOPE, false), NotEnrolledError);
    await assert.rejects(service.updateM365Sources(SCOPE, []), NotEnrolledError);
  });
});

describe("durable-memory gate (Spec 6.1 FR-2)", () => {
  it("durable memory creation fails closed when the pilot setting is off", async () => {
    let durableAllowed = true;
    const gated = new MemoryService({
      memories: memoryStore,
      consents,
      now: () => now,
      durableMemoryGate: async () => durableAllowed,
    });
    await gated.stateExplicit(SCOPE, {
      layer: "semantic",
      kind: "fact",
      subject: "fact:a",
      text: "Allowed while on",
      sources: [{ kind: "explicit-statement", id: "s1", reason: "test" }],
    });
    durableAllowed = false;
    await assert.rejects(
      gated.stateExplicit(SCOPE, {
        layer: "semantic",
        kind: "fact",
        subject: "fact:b",
        text: "Blocked while off",
        sources: [{ kind: "explicit-statement", id: "s2", reason: "test" }],
      }),
      DurableMemoryDisabledError,
    );
    // Working memory is session-scoped and never gated.
    await gated.stateExplicit(SCOPE, {
      layer: "working",
      kind: "retrieval-query",
      subject: "rq:1",
      text: "session note",
      expiresAt: "2026-09-03T16:00:00.000Z",
      sessionId: "sess-1",
      sources: [{ kind: "session", id: "sess-1", reason: "test" }],
    });
    // Approving a proposal is durable creation too.
    const proposal = await gated.propose(SCOPE, {
      layer: "semantic",
      kind: "fact",
      subject: "fact:c",
      text: "A proposed fact",
      sources: [{ kind: "capture", id: "cap-9", reason: "test" }],
    }, { model: "m", version: "v" });
    await assert.rejects(gated.approve(SCOPE, proposal.id), DurableMemoryDisabledError);
    // Without a gate wired, behavior is unchanged (non-pilot installations).
    await memory.stateExplicit(SCOPE, {
      layer: "semantic",
      kind: "fact",
      subject: "fact:d",
      text: "Ungated service still works",
      sources: [{ kind: "explicit-statement", id: "s3", reason: "test" }],
    });
  });
});

describe("redaction (Spec 6.1 SR-2, AC-4)", () => {
  it("enrolled profiles redact by default; exited/unknown do not", () => {
    assert.equal(pilotRedactionActive({ status: "enrolled" }), true);
    assert.equal(pilotRedactionActive({ status: "exited" }), false);
    assert.equal(pilotRedactionActive(undefined), false);
  });

  it("redactContent never leaks a prefix and reveals only with the flag", () => {
    const secret = "the quarterly layoffs discussion transcript";
    const hidden = redactContent(secret, false);
    assert.equal(hidden.includes("layoffs"), false);
    assert.match(hidden, /\[redacted — \d+ chars; re-run with --show-transcripts to view\]/);
    assert.equal(redactContent(secret, true), secret);
  });
});

describe("misfire reporting (Spec 6.1: private path with consent state)", () => {
  it("records category, links, pseudonymous reporter, and consent snapshot", async () => {
    const store = new MemMisfires();
    const register = new MisfireRegister(store, () => now, () => `m-${++idCounter}`);
    const record = await register.report(SCOPE, {
      category: "organization",
      description: "Thought about the vendor call landed in the wrong bucket",
      participantId: "P-01",
      consent: { evalSharing: false },
      captureId: "cap-1",
      thoughtId: "th-1",
    });
    assert.equal(record.status, "open");
    assert.equal(record.consent.evalSharing, false);
    assert.equal(record.participantId, "P-01");
    const listed = await register.list(SCOPE);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, "m-1");
  });

  it("rejects unknown categories and empty descriptions", async () => {
    const register = new MisfireRegister(new MemMisfires(), () => now, () => "m-1");
    await assert.rejects(
      register.report(SCOPE, {
        category: "whatever" as never,
        description: "x",
        participantId: "P-01",
        consent: { evalSharing: false },
      }),
      /Unknown misfire category/,
    );
    await assert.rejects(
      register.report(SCOPE, {
        category: "stt",
        description: "   ",
        participantId: "P-01",
        consent: { evalSharing: false },
      }),
      /needs a description/,
    );
  });
});
