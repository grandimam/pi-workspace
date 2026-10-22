import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { setTimeout } from "node:timers/promises";

export async function readJson(file: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Serialize read-modify-write across Pi processes; never overwrite invalid data. */
export async function updateJson<T>(file: string, parse: (value: unknown) => T, change: (value: T) => void): Promise<T> {
  await mkdir(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  let held = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { const fd = await open(lock, "wx", 0o600); await fd.close(); held = true; break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await setTimeout(50);
    }
  }
  if (!held) throw new Error(`Workspace metadata busy. If no Pi is writing, remove stale lock: ${lock}`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const value = parse(await readJson(file));
    change(value);
    const fd = await open(temporary, "wx", 0o600);
    try { await fd.writeFile(`${JSON.stringify(value, null, 2)}\n`); await fd.sync(); }
    finally { await fd.close(); }
    await rename(temporary, file);
    return value;
  } finally {
    await unlink(temporary).catch(() => {});
    await unlink(lock);
  }
}
