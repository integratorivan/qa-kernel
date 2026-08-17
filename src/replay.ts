import { access, mkdir, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { cleanupProcessGroup, signalProcessGroup } from "./child-process.js";

export interface ReplayOptions {
  packDirectory: string;
  repeat: number;
  outputDirectory?: string;
  signal?: AbortSignal;
}

async function forwardOutput(stream: ReadableStream<Uint8Array>, destination: NodeJS.WriteStream): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      destination.write(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
}

function defaultOutput(packDirectory: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(".qa", "replays", basename(packDirectory), stamp);
}

export async function replayPack(options: ReplayOptions): Promise<number> {
  if (!Number.isInteger(options.repeat) || options.repeat < 1) throw new Error("repeat must be a positive integer");
  const specsDirectory = join(options.packDirectory, "specs");
  let specs: string[];
  try { specs = (await readdir(specsDirectory)).filter((file) => file.endsWith(".spec.ts")); } catch { throw new Error(`replay specs directory is missing: ${specsDirectory}`); }
  if (specs.length === 0) throw new Error(`replay specs directory has no .spec.ts files: ${specsDirectory}`);
  const outputDirectory = resolve(options.outputDirectory ?? defaultOutput(options.packDirectory));
  await mkdir(outputDirectory, { recursive: true });
  const cli = join(import.meta.dir, "..", "node_modules", "@playwright", "test", "cli.js");
  try { await access(cli); } catch { throw new Error("@playwright/test is not installed"); }
  const config = join(import.meta.dir, "..", "playwright.config.ts");
  const child = Bun.spawn([process.execPath, cli, "test", specsDirectory, "--config", config, "--workers", "1", "--repeat-each", String(options.repeat)], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, QA_REPLAY_OUTPUT_DIR: outputDirectory },
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const stdout = forwardOutput(child.stdout, process.stdout);
  const stderr = forwardOutput(child.stderr, process.stderr);
  let interrupted = Boolean(options.signal?.aborted);
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const abortChild = () => {
    interrupted = true;
    signalProcessGroup(child.pid, "SIGINT", () => child.kill("SIGINT"));
    forceTimer = setTimeout(() => signalProcessGroup(child.pid, "SIGKILL", () => child.kill("SIGKILL")), 5_000);
  };
  options.signal?.addEventListener("abort", abortChild, { once: true });
  if (options.signal?.aborted) abortChild();
  try {
    await child.exited;
    const survivors = await cleanupProcessGroup(child.pid, () => child.kill("SIGKILL"));
    if (survivors.length > 0) throw new Error(`replay process group survived cleanup: ${survivors.join(", ")}`);
    await Promise.all([stdout, stderr]);
    return interrupted ? 130 : child.exitCode ?? 1;
  } finally {
    if (forceTimer) clearTimeout(forceTimer);
    options.signal?.removeEventListener("abort", abortChild);
  }
}
