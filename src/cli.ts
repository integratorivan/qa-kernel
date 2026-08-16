#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { discover } from "./discover.js";
import { loadPack } from "./pack.js";
import { markdownReport, summarize } from "./report.js";
import { runPack } from "./run.js";
import { resolveModelConfiguration } from "./model.js";

import { parseYaml, SCHEMA_VERSION, validatePack, validateResult, type CaseResult } from "./schema.js";

interface Arguments {
  command: string;
  values: Record<string, string>;
}

function parseArguments(argv: readonly string[]): Arguments {
  const [command, ...rest] = argv;
  if (!command) throw new Error("missing command");
  const values: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`invalid option near ${key ?? "end of command"}`);
    values[key.slice(2)] = value;
  }
  return { command, values };
}

function requireOption(values: Record<string, string>, key: string): string {
  const value = values[key];
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function usage(): string {
  return [
    "qa discover --url URL --mission TEXT --out PACK/drafts [--pack PACK]",
    "qa validate --pack PACK",
    "qa run --pack PACK --out RUN_DIRECTORY",
    "qa report --run RUN_DIRECTORY",
  ].join("\n");
}

export function interruptController(): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  let signals = 0;
  const onInterrupt = () => {
    signals += 1;
    if (signals === 1) controller.abort(new Error("SIGINT"));
    else process.exit(130);
  };
  process.on("SIGINT", onInterrupt);
  return { controller, dispose: () => process.off("SIGINT", onInterrupt) };
}

async function report(runDirectory: string): Promise<void> {
  const input = JSON.parse(await readFile(join(runDirectory, "results.json"), "utf8")) as { status: "COMPLETED" | "ERROR" | "ABORTED"; results: unknown[] };
  if (!Array.isArray(input.results) || !["COMPLETED", "ERROR", "ABORTED"].includes(input.status)) throw new Error("results.json has an invalid run shape");
  const results: CaseResult[] = input.results.map((result) => validateResult(result));
  const rendered = markdownReport(results, summarize(results, input.status));
  await Bun.write(join(runDirectory, "report.md"), rendered);
  process.stdout.write(rendered);
}

async function execute(command: Arguments): Promise<number> {
  switch (command.command) {
    case "validate": {
      await loadPack(requireOption(command.values, "pack"));
      process.stdout.write("Pack is valid.\n");
      return 0;
    }
    case "run": {
      const interrupt = interruptController();
      try {
        const modelConfiguration = resolveModelConfiguration();
        const output = await runPack({ packDirectory: requireOption(command.values, "pack"), outputDirectory: requireOption(command.values, "out"), apiKey: process.env.QA_MODEL_API_KEY ?? "", modelConfiguration, signal: interrupt.controller.signal });
        process.stdout.write(`${JSON.stringify(output.summary)}\n`);
        return output.summary.exitCode;
      } finally {
        interrupt.dispose();
      }
    }
    case "discover": {
      const draftDirectory = requireOption(command.values, "out");
      const packDirectory = command.values.pack ?? dirname(draftDirectory);
      const pack = validatePack(parseYaml(await readFile(join(packDirectory, "pack.yaml"), "utf8"), "pack.yaml"));
      const targetUrl = requireOption(command.values, "url");
      const environment = { ...process.env, [pack.baseUrlFrom]: targetUrl };
      const discoveryId = new Date().toISOString().replace(/[:.]/g, "-");
      const outputDirectory = join(".qa", "discoveries", discoveryId);
      const modelConfiguration = resolveModelConfiguration();
      const interrupt = interruptController();
      try {
        const output = await discover({ packDirectory, outputDirectory, draftOutputDirectory: draftDirectory, mission: requireOption(command.values, "mission"), apiKey: process.env.QA_MODEL_API_KEY ?? "", modelConfiguration, environment, signal: interrupt.controller.signal });
        process.stdout.write(`${JSON.stringify({ schemaVersion: SCHEMA_VERSION, drafts: output.drafts.map((draft) => ({ id: draft.testCase.id, status: draft.status })) })}\n`);
        return 0;
      } catch (error) {
        if (interrupt.controller.signal.aborted) return 130;
        throw error;
      } finally {
        interrupt.dispose();
      }
    }
    case "report":
      await report(requireOption(command.values, "run"));
      return 0;
    default:
      throw new Error(`unknown command ${command.command}`);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    return await execute(parseArguments(argv));
  } catch (error) {
    process.stderr.write(`qa: ${error instanceof Error ? error.message : String(error)}\n${usage()}\n`);
    return 2;
  }
}

if (import.meta.main) process.exitCode = await main();
