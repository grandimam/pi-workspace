import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
/** No polling or repository hooks: only read Git's HEAD, with a bounded timeout. */
export async function gitBranch(cwd: string): Promise<string | undefined> {
  const options = { cwd, timeout: 1500, maxBuffer: 4096, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } };
  try {
    const { stdout } = await exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], options);
    return stdout.trim() || undefined;
  } catch {
    try { return `${(await exec("git", ["rev-parse", "--short", "HEAD"], options)).stdout.trim()} (detached)`; }
    catch { return undefined; }
  }
}
