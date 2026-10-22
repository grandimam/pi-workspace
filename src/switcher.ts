import { realpath } from "node:fs/promises";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createWorkspaceSession, validateSession, type SessionTarget } from "./sessions.ts";
import { validateDirectory } from "./registry.ts";

export function assertIdle(ctx: Pick<ExtensionCommandContext, "isIdle" | "hasPendingMessages">): void {
  if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Wait for the agent and queued messages to finish before switching");
}
export async function verifyContext(ctx: Pick<ExtensionCommandContext, "cwd" | "sessionManager" | "getSystemPromptOptions">, workspace: string): Promise<void> {
  const expected = await realpath(workspace);
  const prompt = ctx.getSystemPromptOptions().cwd;
  if (await realpath(ctx.cwd) !== expected || await realpath(ctx.sessionManager.getCwd()) !== expected
    || !prompt || await realpath(prompt) !== expected) throw new Error("Workspace context verification failed");
}

export async function switchWorkspace(ctx: ExtensionCommandContext, target: SessionTarget, verified?: (fresh: ExtensionCommandContext) => Promise<void>) {
  assertIdle(ctx);
  const path = await validateDirectory(target.workspace, ctx.cwd);
  let file = target.file;
  if (target.create) file = await createWorkspaceSession(path);
  if (!file) throw new Error("Choose a session or New session");
  await validateSession(file, path);
  assertIdle(ctx); // asynchronous validation must not let an intervening run slip through.
  return ctx.switchSession(file, {
    withSession: async (fresh) => {
      // Throwing here is intentionally fatal in Pi's TUI host. Never reuse old ctx for rollback.
      await verifyContext(fresh, path);
      await verified?.(fresh);
    },
  });
}
