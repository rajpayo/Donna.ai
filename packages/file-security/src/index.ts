/**
 * Cross-platform owner-only file helpers for Donna's private local state.
 *
 * POSIX mode bits do not enforce ACLs on Windows. On Windows we therefore
 * remove inherited/broad grants and allow only the current user and SYSTEM.
 * Every subprocess call uses an argument array (never a shell), and failures
 * are redacted so private paths are not copied into logs.
 */
import { execFile } from "node:child_process";
import {
  appendFile,
  chmod,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SYSTEM_SID = "S-1-5-18";
const BROAD_WINDOWS_SIDS = [
  "S-1-1-0", // Everyone
  "S-1-5-11", // Authenticated Users
  "S-1-5-32-545", // BUILTIN\Users
] as const;

let currentWindowsSidPromise: Promise<string> | undefined;
const hardenedDirectories = new Set<string>();

function windowsSystemTool(name: "whoami.exe" | "icacls.exe"): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);
}

async function currentWindowsSid(): Promise<string> {
  currentWindowsSidPromise ??= execFileAsync(
    windowsSystemTool("whoami.exe"),
    ["/user", "/fo", "csv", "/nh"],
    { windowsHide: true },
  ).then(({ stdout }) => {
    const sid = stdout.match(/\bS-\d-\d+(?:-\d+)+\b/)?.[0];
    if (sid === undefined) {
      throw new Error("Unable to identify the current Windows user");
    }
    return sid;
  });
  return currentWindowsSidPromise;
}

async function hardenWindowsPath(
  path: string,
  kind: "directory" | "file",
): Promise<void> {
  const userSid = await currentWindowsSid();
  const inheritance = kind === "directory" ? "(OI)(CI)" : "";
  await execFileAsync(
    windowsSystemTool("icacls.exe"),
    [
      resolve(path),
      "/inheritance:r",
      "/grant:r",
      `*${userSid}:${inheritance}F`,
      `*${SYSTEM_SID}:${inheritance}F`,
      "/remove:g",
      ...BROAD_WINDOWS_SIDS.map((sid) => `*${sid}`),
      "/Q",
    ],
    { windowsHide: true },
  );
}

async function hardenPath(
  path: string,
  kind: "directory" | "file",
): Promise<void> {
  try {
    if (process.platform === "win32") {
      await hardenWindowsPath(path, kind);
    } else {
      await chmod(path, kind === "directory" ? 0o700 : 0o600);
    }
  } catch {
    throw new Error("Unable to enforce owner-only permissions on private data");
  }
}

/** Create (or harden) an owner-only directory. */
export async function ensurePrivateDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  if (!hardenedDirectories.has(absolute)) {
    await hardenPath(absolute, "directory");
    hardenedDirectories.add(absolute);
  }
}

/** Write a private file and re-apply protection even when it already existed. */
export async function writePrivateFile(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  await writeFile(path, data, { mode: 0o600 });
  if (process.platform !== "win32") {
    await hardenPath(path, "file");
  }
}

/** Append to a private file, creating and protecting it when absent. */
export async function appendPrivateFile(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  await appendFile(path, data, { mode: 0o600 });
  if (process.platform !== "win32") {
    await hardenPath(path, "file");
  }
}
