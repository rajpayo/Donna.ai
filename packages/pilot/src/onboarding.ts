/**
 * Pilot onboarding and settings service (Specification 6.1).
 *
 * Enrollment is affirmative and per-setting: identity (pseudonymous
 * participant ID), permitted data classes, Microsoft 365 source choices,
 * audio-retention acknowledgement (fixed 7 days), durable memory, and
 * optional emotional-context persistence. Every decision lands as a
 * versioned record in the append-only ConsentStore (channel carries
 * `pilot-onboard:<consent-text-version>` / `pilot-set:<version>`), so the
 * exact wording the volunteer agreed to is auditable and revocation
 * history is preserved (FR-1, FR-2).
 *
 * Exit (FR-3) revokes every active consent and marks the profile exited;
 * the CLI layers the verified export/deletion and the M365 cache purge on
 * top. Consent history itself is kept as the audit trail.
 */
import { randomUUID } from "node:crypto";
import {
  m365ReadConsentPurpose,
  type CaptureRecord,
  type CorrectionEvent,
  type M365ReadSourceType,
} from "@donna/core";
import { MemoryService } from "@donna/memory";
import type { MemoryExport } from "@donna/memory";
import {
  EXCLUDED_DATA_CATEGORIES,
  PILOT_AUDIO_RETENTION_DAYS,
  PILOT_AUDIO_RETENTION_PURPOSE,
  PILOT_CONSENT_TEXT_VERSION,
  PILOT_DURABLE_MEMORY_PURPOSE,
  PILOT_ENROLL_PURPOSE,
  pilotDataClassPurpose,
  validatePilotDataClasses,
  type PilotDataClass,
} from "./policy.js";
import {
  PILOT_PROFILE_SCHEMA,
  type PilotProfile,
  type PilotProfileStore,
} from "./profile.js";
import type { MisfireRecord } from "./misfires.js";

const M365_READ_SOURCES: readonly M365ReadSourceType[] = [
  "calendar",
  "mail",
  "teams",
  "files",
];

/** Consent purpose for durable emotional-context persistence (Spec 2.4). */
export const EMOTION_PERSIST_PURPOSE = "emotion.persist";

export class EnrollmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnrollmentError";
  }
}

export class NotEnrolledError extends Error {
  constructor() {
    super(
      "No enrolled pilot profile in this scope. Run `donna pilot onboard` first.",
    );
    this.name = "NotEnrolledError";
  }
}

export interface EnrollmentDecisions {
  /** Pseudonymous handle (e.g. "P-02") — never a name or email. */
  participantId: string;
  /** Requested data classes; validated against exclusions (SR-3). */
  dataClasses: string[];
  /** Chosen Microsoft 365 read sources; [] is the narrow default. */
  m365Sources: M365ReadSourceType[];
  /** Durable cross-session memory allowed. */
  durableMemory: boolean;
  /** Session-scoped tentative emotion inference allowed. */
  emotionInference: boolean;
  /** Persist emotional context beyond the session (separate opt-in). */
  emotionPersistence: boolean;
  /** Affirmative acknowledgements — every one must be true (FR-1). */
  acknowledgements: {
    /** Read the plain-language explanations. */
    explanations: boolean;
    /** Accept the fixed 7-day encrypted audio retention. */
    audioRetention: boolean;
    /** Understand Donna is not authoritative and never acts autonomously. */
    notAuthoritative: boolean;
  };
}

export interface PilotExport {
  schema: "donna.pilot-export.v1";
  exportedAt: string;
  tenantId: string;
  userId: string;
  participantId: string;
  profile: PilotProfile;
  /** Memories, proposals, events, and the full consent history. */
  memory: MemoryExport;
  /** Capture metadata (never audio bytes). */
  captures: CaptureRecord[];
  corrections: CorrectionEvent[];
  misfires: MisfireRecord[];
}

export interface PilotServiceDeps {
  profiles: PilotProfileStore;
  memory: MemoryService;
  now: () => Date;
  idGen?: () => string;
}

export interface Scope {
  tenantId: string;
  userId: string;
}

/** Pseudonymous handles: letters/digits/dash, 2–32 chars, never an email. */
const PARTICIPANT_ID = /^(?!.*@)[A-Za-z][A-Za-z0-9-]{1,31}$/;

export class PilotService {
  private readonly idGen: () => string;

  constructor(private readonly deps: PilotServiceDeps) {
    this.idGen = deps.idGen ?? randomUUID;
  }

  /* ---------------------------- enrollment ----------------------------- */

  async enroll(scope: Scope, decisions: EnrollmentDecisions): Promise<PilotProfile> {
    const existing = await this.deps.profiles.get(scope.tenantId, scope.userId);
    if (existing !== undefined && existing.status === "enrolled") {
      throw new EnrollmentError(
        "Already enrolled. Change settings with `donna pilot set …` or leave with `donna pilot leave`.",
      );
    }
    if (!PARTICIPANT_ID.test(decisions.participantId)) {
      throw new EnrollmentError(
        "Participant ID must be a pseudonymous handle (letters, digits, dashes; 2–32 chars) — never a name or email.",
      );
    }
    const dataClasses = validatePilotDataClasses(decisions.dataClasses);
    if (dataClasses.length === 0) {
      throw new EnrollmentError("Choose at least one permitted data class.");
    }
    const sources = [...new Set(decisions.m365Sources)];
    for (const source of sources) {
      if (!M365_READ_SOURCES.includes(source)) {
        throw new EnrollmentError(`Unknown Microsoft 365 source "${source}".`);
      }
    }
    if (decisions.emotionPersistence && !decisions.emotionInference) {
      throw new EnrollmentError(
        "Emotional-context persistence requires session emotion inference to be on — Donna cannot persist what it does not infer.",
      );
    }
    const missing = Object.entries(decisions.acknowledgements)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new EnrollmentError(
        `Enrollment needs your affirmative acknowledgement of: ${missing.join(", ")}. ` +
          "Read the explanations (`donna pilot explain`) and confirm each one.",
      );
    }

    const now = this.deps.now().toISOString();
    const profile: PilotProfile = {
      schema: PILOT_PROFILE_SCHEMA,
      tenantId: scope.tenantId,
      userId: scope.userId,
      participantId: decisions.participantId,
      enrolledAt: now,
      consentTextVersion: PILOT_CONSENT_TEXT_VERSION,
      dataClasses,
      m365Sources: sources,
      audioRetentionDays: PILOT_AUDIO_RETENTION_DAYS,
      durableMemory: decisions.durableMemory,
      emotionInference: decisions.emotionInference,
      emotionPersistence: decisions.emotionPersistence,
      status: "enrolled",
      updatedAt: now,
    };

    // FR-1: versioned consent records BEFORE any personal-data processing.
    const channel = `pilot-onboard:${PILOT_CONSENT_TEXT_VERSION}`;
    const memory = this.deps.memory;
    await memory.grantConsent(scope, PILOT_ENROLL_PURPOSE, channel);
    await memory.grantConsent(scope, PILOT_AUDIO_RETENTION_PURPOSE, channel);
    for (const dataClass of dataClasses) {
      await memory.grantConsent(scope, pilotDataClassPurpose(dataClass), channel);
    }
    // Every choice is recorded affirmatively — grants for what was chosen,
    // explicit denials for what was not, so "narrow by default" is visible
    // in the audit trail rather than implied by absence.
    if (decisions.durableMemory) {
      await memory.grantConsent(scope, PILOT_DURABLE_MEMORY_PURPOSE, channel);
    } else {
      await memory.denyConsent(scope, PILOT_DURABLE_MEMORY_PURPOSE, channel);
    }
    for (const source of M365_READ_SOURCES) {
      const purpose = m365ReadConsentPurpose(source);
      if (sources.includes(source)) {
        await memory.grantConsent(scope, purpose, channel);
      } else {
        await memory.denyConsent(scope, purpose, channel);
      }
    }
    if (decisions.emotionPersistence) {
      await memory.grantConsent(scope, EMOTION_PERSIST_PURPOSE, channel);
    } else {
      await memory.denyConsent(scope, EMOTION_PERSIST_PURPOSE, channel);
    }

    await this.deps.profiles.save(profile);
    return profile;
  }

  /* ---------------------------- inspection ----------------------------- */

  async getProfile(scope: Scope): Promise<PilotProfile | undefined> {
    return this.deps.profiles.get(scope.tenantId, scope.userId);
  }

  async requireEnrolled(scope: Scope): Promise<PilotProfile> {
    const profile = await this.deps.profiles.get(scope.tenantId, scope.userId);
    if (profile === undefined || profile.status !== "enrolled") {
      throw new NotEnrolledError();
    }
    return profile;
  }

  /* --------------------------- setting changes ------------------------- */

  /**
   * FR-2: change the permitted data classes. Excluded categories are
   * rejected with a clear message (SR-3); grants/denials are re-recorded
   * per class so the consent trail always reflects the current set.
   */
  async updateDataClasses(
    scope: Scope,
    classes: string[],
  ): Promise<{ profile: PilotProfile; granted: string[]; revoked: string[] }> {
    const profile = await this.requireEnrolled(scope);
    const next = validatePilotDataClasses(classes);
    if (next.length === 0) {
      throw new EnrollmentError("Choose at least one permitted data class.");
    }
    const channel = `pilot-set:${PILOT_CONSENT_TEXT_VERSION}`;
    const granted: string[] = [];
    const revoked: string[] = [];
    for (const dataClass of next) {
      if (!profile.dataClasses.includes(dataClass)) {
        await this.deps.memory.grantConsent(scope, pilotDataClassPurpose(dataClass), channel);
        granted.push(dataClass);
      }
    }
    for (const previous of profile.dataClasses) {
      if (!next.includes(previous)) {
        await this.deps.memory.revokeConsent(scope, pilotDataClassPurpose(previous), channel);
        revoked.push(previous);
      }
    }
    return {
      profile: await this.saveSettings(scope, profile, { dataClasses: next }),
      granted,
      revoked,
    };
  }

  /**
   * FR-2: change the chosen Microsoft 365 read sources. Added sources get
   * a grant; removed sources get a revocation (which fails every M365 read
   * path closed on its consent gate). The CLI additionally purges cached
   * snippets and drops selections of revoked types.
   */
  async updateM365Sources(
    scope: Scope,
    sources: M365ReadSourceType[],
  ): Promise<{ profile: PilotProfile; granted: string[]; revoked: string[] }> {
    const profile = await this.requireEnrolled(scope);
    const next = [...new Set(sources)];
    for (const source of next) {
      if (!M365_READ_SOURCES.includes(source)) {
        throw new EnrollmentError(`Unknown Microsoft 365 source "${source}".`);
      }
    }
    const channel = `pilot-set:${PILOT_CONSENT_TEXT_VERSION}`;
    const granted: string[] = [];
    const revoked: string[] = [];
    for (const source of next) {
      if (!profile.m365Sources.includes(source)) {
        await this.deps.memory.grantConsent(scope, m365ReadConsentPurpose(source), channel);
        granted.push(source);
      }
    }
    for (const previous of profile.m365Sources) {
      if (!next.includes(previous)) {
        await this.deps.memory.revokeConsent(scope, m365ReadConsentPurpose(previous), channel);
        revoked.push(previous);
      }
    }
    return {
      profile: await this.saveSettings(scope, profile, { m365Sources: next }),
      granted,
      revoked,
    };
  }

  /** FR-2: durable-memory switch. Off is an explicit denial record. */
  async setDurableMemory(scope: Scope, on: boolean): Promise<PilotProfile> {
    const profile = await this.requireEnrolled(scope);
    if (profile.durableMemory === on) return profile;
    const channel = `pilot-set:${PILOT_CONSENT_TEXT_VERSION}`;
    if (on) {
      await this.deps.memory.grantConsent(scope, PILOT_DURABLE_MEMORY_PURPOSE, channel);
    } else {
      await this.deps.memory.denyConsent(scope, PILOT_DURABLE_MEMORY_PURPOSE, channel);
    }
    return this.saveSettings(scope, profile, { durableMemory: on });
  }

  /** FR-2: session-scoped emotion inference switch. */
  async setEmotionInference(scope: Scope, on: boolean): Promise<PilotProfile> {
    const profile = await this.requireEnrolled(scope);
    if (!on && profile.emotionPersistence) {
      // Turning inference off also ends persistence — Donna cannot persist
      // what it does not infer.
      await this.deps.memory.revokeConsent(
        scope,
        EMOTION_PERSIST_PURPOSE,
        `pilot-set:${PILOT_CONSENT_TEXT_VERSION}`,
      );
      return this.saveSettings(scope, profile, {
        emotionInference: false,
        emotionPersistence: false,
      });
    }
    return this.saveSettings(scope, profile, { emotionInference: on });
  }

  /** FR-2: emotional-context persistence — the separate opt-in. */
  async setEmotionPersistence(scope: Scope, on: boolean): Promise<PilotProfile> {
    const profile = await this.requireEnrolled(scope);
    if (on && !profile.emotionInference) {
      throw new EnrollmentError(
        "Emotional-context persistence requires session emotion inference — enable it first: donna pilot set emotion-inference on",
      );
    }
    if (profile.emotionPersistence === on) return profile;
    const channel = `pilot-set:${PILOT_CONSENT_TEXT_VERSION}`;
    if (on) {
      await this.deps.memory.grantConsent(scope, EMOTION_PERSIST_PURPOSE, channel);
    } else {
      await this.deps.memory.revokeConsent(scope, EMOTION_PERSIST_PURPOSE, channel);
    }
    return this.saveSettings(scope, profile, { emotionPersistence: on });
  }

  /* ------------------------------- exit -------------------------------- */

  /**
   * FR-3, consent half: revoke EVERY active consent for the scope
   * (pilot.*, m365.*, emotion.persist, eval-sharing — whatever exists) and
   * mark the profile exited. History stays append-only. The M365 snippet
   * purge and any data deletion are layered on by the CLI.
   */
  async exit(scope: Scope): Promise<{ profile: PilotProfile; revokedPurposes: string[] }> {
    const profile = await this.requireEnrolled(scope);
    const revokedPurposes: string[] = [];
    const purposes = [...new Set((await this.deps.memory.listConsents(scope)).map((r) => r.purpose))];
    for (const purpose of purposes) {
      if (await this.deps.memory.hasConsent(scope, purpose)) {
        await this.deps.memory.revokeConsent(scope, purpose, "pilot:leave");
        revokedPurposes.push(purpose);
      }
    }
    const exited = await this.saveSettings(scope, profile, { status: "exited" });
    return { profile: exited, revokedPurposes };
  }

  /* ------------------------------- export ------------------------------ */

  /** FR-3: everything the pilot holds for this scope, one bundle. */
  async exportBundle(
    scope: Scope,
    extras: {
      captures?: CaptureRecord[];
      corrections?: CorrectionEvent[];
      misfires?: MisfireRecord[];
    } = {},
  ): Promise<PilotExport> {
    const profile = await this.requireEnrolled(scope);
    const memory = await this.deps.memory.exportAll(scope);
    return {
      schema: "donna.pilot-export.v1",
      exportedAt: this.deps.now().toISOString(),
      tenantId: scope.tenantId,
      userId: scope.userId,
      participantId: profile.participantId,
      profile,
      memory,
      captures: extras.captures ?? [],
      corrections: extras.corrections ?? [],
      misfires: extras.misfires ?? [],
    };
  }

  /* ----------------------------- internals ----------------------------- */

  private async saveSettings(
    scope: Scope,
    profile: PilotProfile,
    updates: Partial<PilotProfile>,
  ): Promise<PilotProfile> {
    const next: PilotProfile = {
      ...profile,
      ...updates,
      tenantId: scope.tenantId,
      userId: scope.userId,
      updatedAt: this.deps.now().toISOString(),
      ...(updates.status === "exited"
        ? { exitedAt: this.deps.now().toISOString() }
        : {}),
    };
    await this.deps.profiles.save(next);
    return next;
  }
}

/** The excluded-category list rendered for user-facing messages. */
export function excludedCategoryList(): string {
  return EXCLUDED_DATA_CATEGORIES.join(", ");
}
