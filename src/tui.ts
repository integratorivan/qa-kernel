#!/usr/bin/env bun
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join } from "node:path";
import { main } from "./cli.js";

export const REQUIRED_ENV = ["TARGET_URL", "QA_ALLOWED_ORIGINS", "QA_EMAIL", "QA_PASSWORD", "QA_MODEL_API_KEY"] as const;

export interface EnvironmentStatus {
  present: string[];
  missing: string[];
  warnings: string[];
}

export function environmentStatus(environment: NodeJS.ProcessEnv = process.env): EnvironmentStatus {
  const present = REQUIRED_ENV.filter((key) => Boolean(environment[key]));
  const missing = REQUIRED_ENV.filter((key) => !environment[key]);
  const warnings: string[] = [];
  if (environment.QA_PASSWORD === "replace-with-a-test-password") {
    warnings.push("QA_PASSWORD is still the .env.example placeholder; fixture login expects the same value as the fixture process");
  }
  return { present, missing, warnings };
}

export async function loadDotEnv(file: string, environment: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const loaded: string[] = [];
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return loaded;
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith("\"") && value.endsWith("\""))) value = value.slice(1, -1);
    if (environment[key] === undefined) {
      environment[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}

export async function listYaml(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).filter((file) => file.endsWith(".yaml")).sort();
  } catch {
    return [];
  }
}

export async function approveDraft(packDirectory: string, fileName: string): Promise<string> {
  if (!fileName.endsWith(".yaml") || fileName.includes("/") || fileName.includes("\\")) throw new Error(`invalid draft name ${fileName}`);
  const from = join(packDirectory, "drafts", fileName);
  const to = join(packDirectory, "cases", fileName);
  await mkdir(join(packDirectory, "cases"), { recursive: true });
  const existing = await listYaml(join(packDirectory, "cases"));
  if (existing.includes(fileName)) throw new Error(`${fileName} is already in cases/`);
  await rename(from, to);
  return to;
}

export async function latestRun(root: string): Promise<string | null> {
  try {
    const names = (await readdir(join(root, ".qa", "runs"))).sort();
    const last = names.at(-1);
    return last ? join(root, ".qa", "runs", last) : null;
  } catch {
    return null;
  }
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function fixtureUp(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function printStatus(packDirectory: string, drafts: readonly string[], cases: readonly string[], env: EnvironmentStatus, fixture: boolean, lastRun: string | null): void {
  process.stdout.write("\nqa-kernel  (CLI wrapper, not the product UI)\n");
  process.stdout.write(`pack     ${packDirectory}   approved ${cases.length}   drafts ${drafts.length}\n`);
  process.stdout.write(`env      ${env.missing.length === 0 ? "ready" : `missing ${env.missing.join(", ")}`}\n`);
  process.stdout.write(`fixture  ${fixture ? "up" : "down"}   ${process.env.TARGET_URL ?? "(no TARGET_URL)"}\n`);
  process.stdout.write(`last run ${lastRun ?? "(none)"}\n`);
  for (const warning of env.warnings) process.stdout.write(`warning  ${warning}\n`);
  process.stdout.write("\n1 check env     2 start fixture     3 validate\n");
  process.stdout.write("4 discover      5 approve drafts     6 run\n");
  process.stdout.write("7 report        8 open last run      0 quit\n\n");
}

async function runQa(argv: string[]): Promise<number> {
  process.stdout.write(`$ qa ${argv.join(" ")}\n`);
  const code = await main(argv);
  process.stdout.write(`exit ${code}\n`);
  return code;
}

export async function loop(root = process.cwd()): Promise<void> {
  await loadDotEnv(join(root, ".env"));
  const packDirectory = join(root, "packs", "fixture-smoke");
  let fixtureProcess: ReturnType<typeof Bun.spawn> | null = null;

  try {
    while (true) {
      const [drafts, cases, lastRun] = await Promise.all([listYaml(join(packDirectory, "drafts")), listYaml(join(packDirectory, "cases")), latestRun(root)]);
      const env = environmentStatus();
      const fixture = process.env.TARGET_URL ? await fixtureUp(process.env.TARGET_URL) : false;
      printStatus(packDirectory, drafts, cases, env, fixture, lastRun);
      const choice = await prompt("> ");
      if (choice === "0" || choice === "q" || choice === "quit") return;

      if (choice === "1") {
        process.stdout.write(`${JSON.stringify(environmentStatus(), null, 2)}\n`);
        process.stdout.write(`model ${process.env.QA_MODEL_PROVIDER ?? "openrouter"} ${process.env.QA_MODEL_ID ?? "(default)"}\n`);
        continue;
      }

      if (choice === "2") {
        if (!process.env.TARGET_URL) {
          process.stdout.write("set TARGET_URL first\n");
          continue;
        }
        if (await fixtureUp(process.env.TARGET_URL)) {
          process.stdout.write("fixture already up\n");
          continue;
        }
        fixtureProcess ??= Bun.spawn(["bun", "run", "fixtures/b2b-fixture.ts"], { cwd: root, env: process.env, stdout: "inherit", stderr: "inherit" });
        process.stdout.write("fixture starting on TARGET_URL\n");
        continue;
      }

      if (choice === "3") {
        await runQa(["validate", "--pack", packDirectory]);
        continue;
      }

      if (choice === "4") {
        const mission = (await prompt("mission [Проверить логин и основные разделы кабинета]: ")) || "Проверить логин и основные разделы кабинета";
        const url = process.env.TARGET_URL;
        if (!url) {
          process.stdout.write("set TARGET_URL first\n");
          continue;
        }
        await runQa(["discover", "--url", url, "--mission", mission, "--out", join(packDirectory, "drafts"), "--pack", packDirectory]);
        continue;
      }

      if (choice === "5") {
        if (drafts.length === 0) {
          process.stdout.write("no drafts; run discover first\n");
          continue;
        }
        for (const file of drafts) {
          const source = await readFile(join(packDirectory, "drafts", file), "utf8");
          process.stdout.write(`\n--- ${file} ---\n${source}\n`);
        }
        const selected = await prompt("approve file name, or 'all': ");
        const files = selected === "all" ? drafts : drafts.filter((file) => file === selected || file === `${selected}.yaml`);
        if (files.length === 0) {
          process.stdout.write("nothing selected\n");
          continue;
        }
        for (const file of files) {
          const destination = await approveDraft(packDirectory, file);
          process.stdout.write(`approved ${destination}\n`);
        }
        continue;
      }

      if (choice === "6") {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await runQa(["run", "--pack", packDirectory, "--out", join(root, ".qa", "runs", `tui-${stamp}`)]);
        continue;
      }

      if (choice === "7") {
        const runDirectory = lastRun ?? (await prompt("run directory: "));
        if (!runDirectory) continue;
        await runQa(["report", "--run", runDirectory]);
        continue;
      }

      if (choice === "8") {
        if (!lastRun) {
          process.stdout.write("no runs yet\n");
          continue;
        }
        await Bun.spawn(["open", lastRun], { cwd: root }).exited;
        continue;
      }

      process.stdout.write("unknown choice\n");
    }
  } finally {
    fixtureProcess?.kill();
  }
}

if (import.meta.main) await loop();
