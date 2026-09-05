/**
 * Eval isolation (Specification 4.1, FR-4, SR-3).
 *
 * Eval runs use dedicated tenant/user IDs and dedicated data directories,
 * and the harness asserts both BEFORE any store is touched:
 *
 *   - Scope: every eval scope ID must carry the `eval-` prefix. The CLI's
 *     pilot scope (default `demo-tenant` / the product owner's user) can
 *     never be selected by an eval runner.
 *   - Data: eval data directories must live under the OS temp dir or the
 *     evals package's own gitignored scratch/reports directories — never
 *     under the CLI data dir (`<repo>/data` or $DONNA_DATA_DIR), so report
 *     generation can never write to pilot/user data.
 *
 * Database isolation (SR-3) is enforced by PostgreSQL row-level security
 * from Specification 3.2; the eval scope sees only `eval-` rows. The
 * integration test in this package proves the eval tenant cannot read
 * rows written under a pilot tenant.
 */
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";

/** Dedicated eval scope. Every eval runner must use these (or `eval-`-prefixed variants). */
export const EVAL_TENANT_ID = "eval-tenant";
export const EVAL_USER_ID = "eval-user";

export const EVAL_SCOPE = {
  tenantId: EVAL_TENANT_ID,
  userId: EVAL_USER_ID,
} as const;

export class EvalIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalIsolationError";
  }
}

/** FR-4: eval runs may only ever act on eval-prefixed scopes. */
export function assertEvalScope(scope: {
  tenantId: string;
  userId: string;
}): void {
  if (!scope.tenantId.startsWith("eval-")) {
    throw new EvalIsolationError(
      `Eval tenant IDs must start with "eval-", got "${scope.tenantId.slice(0, 3)}…"`,
    );
  }
  if (!scope.userId.startsWith("eval-")) {
    throw new EvalIsolationError(
      `Eval user IDs must start with "eval-", got "${scope.userId.slice(0, 3)}…"`,
    );
  }
}

export interface AssertEvalDataDirOptions {
  /** Repository root (the CLI pilot data dir lives under it). */
  repoRoot: string;
  /** The evals package directory (scratch/reports under it are allowed). */
  evalsDir: string;
}

function canonical(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isInside(child: string, parent: string): boolean {
  const c = canonical(child);
  const p = canonical(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * FR-4: assert an eval data directory is isolated from pilot/user state.
 * Allowed roots: the OS temp dir, or the evals package itself (scratch
 * and reports). Forbidden: the CLI data dir and anything outside the
 * allowed roots.
 */
export function assertEvalDataDir(
  dir: string,
  options: AssertEvalDataDirOptions,
): void {
  const cliDataDir = process.env.DONNA_DATA_DIR !== undefined
    ? resolve(process.env.DONNA_DATA_DIR)
    : resolve(options.repoRoot, "data");
  if (isInside(dir, cliDataDir) || isInside(cliDataDir, dir)) {
    throw new EvalIsolationError(
      "Eval data dir overlaps the CLI pilot data dir — evals never write to user data",
    );
  }
  const allowed =
    isInside(dir, tmpdir()) || isInside(dir, options.evalsDir);
  if (!allowed) {
    throw new EvalIsolationError(
      "Eval data dir must live under the OS temp dir or the evals package",
    );
  }
}
