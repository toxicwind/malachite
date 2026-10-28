// malachite flatten — anything (sqlite db, jsonl, tar.gz report bundle) -> flat csv/jsonl + manifest
// Zero deps: bun:sqlite + node fs. Untruncated: full column sets, no line caps.
import { Database } from "bun:sqlite";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  statSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, join, dirname } from "node:path";

export type Row = Record<string, unknown>;
export interface Dataset {
  name: string;
  rows: number;
  cols: number;
  bytes: number;
}

const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") v = JSON.stringify(v);
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

// deep-flatten nested objects with accumulated prefixes; arrays inlined as JSON strings
export const flattenValue = (
  key: string,
  v: unknown,
  out: Row,
  prefix = "",
) => {
  const k = prefix ? `${prefix}_${key}` : key;
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    for (const [ck, cv] of Object.entries(v as Row))
      flattenValue(ck, cv, out, k);
  } else if (Array.isArray(v)) out[k] = JSON.stringify(v);
  else out[k] = v;
};

const flatCols = (rows: Row[]): string[] => {
  const cols: string[] = [];
  for (const r of rows)
    for (const c of Object.keys(r)) if (!cols.includes(c)) cols.push(c);
  return cols;
};

export function emit(outdir: string, name: string, rows: Row[]): Dataset {
  if (!rows.length) return { name, rows: 0, cols: 0, bytes: 0 };
  const cols = flatCols(rows);
  const csvPath = join(outdir, `${name}.csv`);
  const csv = [
    cols.join(","),
    ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(",")),
  ].join("\n");
  writeFileSync(csvPath, csv);
  writeFileSync(
    join(outdir, `${name}.jsonl`),
    rows.map((r) => JSON.stringify(r)).join("\n"),
  );
  return {
    name,
    rows: rows.length,
    cols: cols.length,
    bytes: statSync(csvPath).size,
  };
}

export function flattenDb(dbPath: string, outdir: string, datasets: Dataset[]) {
  const tag = basename(dbPath)
    .replace(/\.db$/, "")
    .replace(/[^a-z0-9]/gi, "_");
  const db = new Database(dbPath, { readonly: true });
  const tables = db
    .query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { name: string }[];
  for (const { name: t } of tables) {
    try {
      const rows = db.query(`SELECT * FROM "${t}"`).all() as Row[];
      const flat = rows.map((r) => {
        const o: Row = {};
        for (const [k, v] of Object.entries(r)) flattenValue(k, v, o);
        return o;
      });
      datasets.push(emit(outdir, `${tag}.${t}`, flat));
    } catch (e) {
      console.error(`[malachite] ${tag}.${t}:`, e);
    }
  }
  db.close();
}

export function flattenJsonl(p: string, outdir: string, datasets: Dataset[]) {
  const tag = basename(p)
    .replace(/\.jsonl$/, "")
    .replace(/[^a-z0-9]/gi, "_");
  const rows: Row[] = [];
  for (const [i, line] of readFileSync(p, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      const o: Row = { _line: i + 1 };
      flattenValue("json", j, o);
      o._raw = line;
      rows.push(o);
    } catch {
      rows.push({ _line: i + 1, _raw: line, _parse_error: true });
    }
  }
  datasets.push(emit(outdir, tag, rows));
}

// tar.gz report bundle -> extract to a scratch sibling -> flatten every db/jsonl inside
export function flattenBundle(
  tarPath: string,
  outdir: string,
  datasets: Dataset[],
): string {
  const scratch = join(
    outdir,
    `_bundle_${basename(tarPath).replace(/[^a-z0-9]/gi, "_")}`,
  );
  mkdirSync(scratch, { recursive: true });
  Bun.spawnSync(["tar", "-xzf", tarPath, "-C", scratch]);
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".db")) flattenDb(p, outdir, datasets);
      else if (e.name.endsWith(".jsonl")) flattenJsonl(p, outdir, datasets);
    }
  };
  walk(scratch);
  return scratch;
}

export function flatten(inputs: string[], outdir: string): Dataset[] {
  mkdirSync(outdir, { recursive: true });
  const datasets: Dataset[] = [];
  for (const input of inputs) {
    if (!existsSync(input)) {
      console.error(`[malachite] missing: ${input}`);
      continue;
    }
    if (input.endsWith(".tar.gz") || input.endsWith(".tgz"))
      datasets.push({
        name: `bundle:${basename(input)}`,
        ...flattenBundle(input, outdir, datasets),
        rows: 0,
        cols: 0,
        bytes: 0,
      } as Dataset);
    else if (input.endsWith(".db") || input.endsWith(".sqlite"))
      flattenDb(input, outdir, datasets);
    else if (input.endsWith(".jsonl")) flattenJsonl(input, outdir, datasets);
    else
      console.error(
        `[malachite] unsupported input (want .db/.jsonl/.tar.gz): ${input}`,
      );
  }
  writeFileSync(
    join(outdir, "manifest.json"),
    JSON.stringify(datasets, null, 2),
  );
  return datasets.filter((d) => d.rows !== 0 || d.cols !== 0);
}
