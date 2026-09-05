import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";
import {
  appendPrivateFile,
  ensurePrivateDirectory,
  writePrivateFile,
} from "./index.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "donna-private-files-"));
  roots.push(root);
  return root;
}

describe("private file security", () => {
  it("writes and appends without changing the payload", async () => {
    const root = await privateRoot();
    const file = join(root, "scope", "state.json");
    await writePrivateFile(file, "{\"one\":1}");
    await appendPrivateFile(file, "\n{\"two\":2}");
    assert.equal(
      await readFile(file, "utf8"),
      "{\"one\":1}\n{\"two\":2}",
    );
  });

  it("enforces owner-only protection on the host platform", async () => {
    const root = await privateRoot();
    const directory = join(root, "scope");
    const file = join(directory, "state.json");
    await ensurePrivateDirectory(directory);
    await writePrivateFile(file, "{}");

    if (process.platform === "win32") {
      const [{ stdout: directoryAcl }, { stdout: fileAcl }] = await Promise.all([
        execFileAsync("icacls.exe", [directory], { windowsHide: true }),
        execFileAsync("icacls.exe", [file], { windowsHide: true }),
      ]);
      const acl = `${directoryAcl}\n${fileAcl}`;
      assert.doesNotMatch(
        acl,
        /Everyone|Authenticated Users|BUILTIN\\Users/i,
      );
      assert.match(acl, /SYSTEM/i);
    } else {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
  });
});
