import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { computeTabularFeatures } from "./feature_schema.ts";
import type { RugCheckSummary, TokenLaunchEvent } from "../token_risk_scorer.ts";

interface FeatureCliRow {
  event: TokenLaunchEvent;
  rugcheck?: RugCheckSummary;
}

export const computeFeatureRows = async (path: string): Promise<Array<Record<string, number>>> => {
  const raw = await readFile(path, "utf8");
  return raw.split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FeatureCliRow)
    .map((row) => computeTabularFeatures(row));
};

const main = async (): Promise<void> => {
  const path = process.argv[2];
  if (!path) {
    throw new Error("usage: node --experimental-strip-types src/features/feature_cli.ts samples.jsonl");
  }
  const rows = await computeFeatureRows(path);
  process.stdout.write(`${JSON.stringify(rows)}\n`);
};

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";

if (import.meta.url === entryUrl) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
