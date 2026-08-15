import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { configuredOrigins, parseYaml, SchemaError, type Pack, type TestCase, validateCase, validatePack } from "./schema.js";

export interface LoadedCase {
  testCase: TestCase;
  source: string;
  file: string;
}

export interface LoadedPack {
  directory: string;
  pack: Pack;
  cases: LoadedCase[];
  allowedOrigins: string[];
}


export interface LoadPackOptions {
  requireCases?: boolean;
}

export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackError";
  }
}

export async function loadPack(directory: string, environment: NodeJS.ProcessEnv = process.env, options: LoadPackOptions = {}): Promise<LoadedPack> {
  let pack: Pack;
  try {
    pack = validatePack(parseYaml(await readFile(join(directory, "pack.yaml"), "utf8"), "pack.yaml"));
  } catch (error) {
    throw new PackError(error instanceof Error ? error.message : String(error));
  }
  const caseDirectory = join(directory, "cases");
  let files: string[];
  try {
    files = (await readdir(caseDirectory)).filter((file) => file.endsWith(".yaml")).sort();
  } catch (error) {
    if (options.requireCases === false && error && typeof error === "object" && "code" in error && error.code === "ENOENT") files = [];
    else throw new PackError(`cannot read approved cases: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (options.requireCases !== false && files.length === 0) throw new PackError("pack has no approved YAML cases in cases/");
  const cases: LoadedCase[] = [];
  for (const file of files) {
    const source = await readFile(join(caseDirectory, file), "utf8");
    try {
      cases.push({ testCase: validateCase(parseYaml(source, `cases/${file}`), pack), source, file });
    } catch (error) {
      throw new PackError(error instanceof Error ? error.message : String(error));
    }
  }
  if (new Set(cases.map((item) => item.testCase.id)).size !== cases.length) throw new PackError("approved case IDs must be unique");
  let allowedOrigins: string[];
  try {
    allowedOrigins = configuredOrigins(pack, environment);
  } catch (error) {
    if (error instanceof SchemaError) throw new PackError(error.message);
    throw error;
  }
  for (const secretRef of pack.allowedSecretRefs) {
    if (!environment[secretRef]) throw new PackError(`missing allowlisted secret ${secretRef}`);
  }
  return { directory, pack, cases, allowedOrigins };
}

export function secretsForCase(testCase: TestCase, environment: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const values = new Map<string, string>();
  for (const ref of Object.values(testCase.data)) {
    const value = environment[ref];
    if (!value) throw new PackError(`missing allowlisted secret ${ref}`);
    values.set(ref, value);
  }
  return values;
}
