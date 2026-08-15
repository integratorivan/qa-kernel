import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type EvidenceKind = "screenshot" | "snapshot" | "network";
export type EvidencePhase = "before" | "after";

export interface Evidence {
  id: string;
  caseId: string;
  stepId: string;
  actionOrdinal: number;
  phase: EvidencePhase;
  kind: EvidenceKind;
  url: string;
  createdAt: string;
  hash: string;
  file: string;
}

export interface EvidenceReference {
  caseId: string;
  stepId: string;
  evidenceIds: string[];
}

export class EvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceError";
  }
}

export class SecretRedactor {
  readonly #secrets: string[];

  constructor(values: Iterable<string>) {
    this.#secrets = [...values].filter((value) => value.length > 0).sort((a, b) => b.length - a.length);
  }

  redact(value: string): string {
    return this.#secrets.reduce((redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"), value);
  }
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

export async function appendNdjson(path: string, value: unknown): Promise<void> {
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

export class EvidenceStore {
  readonly #byId = new Map<string, Evidence>();

  constructor(private readonly root: string, private readonly redact: SecretRedactor) {}
  redactText(value: string): string {
    return this.redact.redact(value);
  }


  async record(input: Omit<Evidence, "id" | "createdAt" | "hash" | "file"> & { extension: string; content: string | Uint8Array }): Promise<Evidence> {
    const id = `ev-${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const directory = input.kind === "screenshot" ? "screenshots" : input.kind === "snapshot" ? "snapshots" : "network";
    const file = join(directory, `${id}.${input.extension}`);
    const bytes = typeof input.content === "string" ? new TextEncoder().encode(this.redact.redact(input.content)) : input.content;
    const hash = createHash("sha256").update(bytes).digest("hex");
    const fullPath = join(this.root, file);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, bytes);
    const evidence: Evidence = { id, caseId: input.caseId, stepId: input.stepId, actionOrdinal: input.actionOrdinal, phase: input.phase, kind: input.kind, url: this.redact.redact(input.url), createdAt, hash, file };
    this.#byId.set(id, evidence);

    await appendNdjson(join(this.root, "evidence.ndjson"), evidence);
    if (evidence.kind === "network") await appendNdjson(join(this.root, "network.ndjson"), evidence);
    return evidence;
  }

  all(): Evidence[] {
    return [...this.#byId.values()];
  }

  validate(reference: EvidenceReference): void {
    for (const id of reference.evidenceIds) {
      const evidence = this.#byId.get(id);
      if (!evidence) throw new EvidenceError(`unknown evidence ${id}`);
      if (evidence.caseId !== reference.caseId) throw new EvidenceError(`evidence ${id} belongs to ${evidence.caseId}, not ${reference.caseId}`);
      if (evidence.stepId !== reference.stepId) throw new EvidenceError(`evidence ${id} belongs to step ${evidence.stepId}, not ${reference.stepId}`);
    }
  }
}
