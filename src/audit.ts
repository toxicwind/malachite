// malachite audit — claim-vs-reality verdicts over a flattened malachite dir
// Detects: empty-output model calls (output≈0), aborted calls, 429/402 taxonomy,
// tool validation failures, and "gaslighting" (verification claims while verify items pending).
import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

interface Flat {
  rows: number;
  cols: number;
  bytes: number;
  name: string;
}
const CLAIM_RE =
  /\b(verified|healthy|all (three|\d+) surfaces|done|complete[d]?|fixed|works now|passing)\b/i;
const PENDING_RE = /\b(pending|in_progress|not (verified|done)|failed)\b/i;
const ERROR_RE =
  /\b(error|fail(ed|ure)?|denied|timeout|429|402|401|403|ENOENT|Validation failed)\b/i;

export function audit(dir: string): string {
  const out: string[] = ["# malachite audit", ""];
  const manifest = JSON.parse(
    readFileSync(join(dir, "manifest.json"), "utf8"),
  ) as Flat[];
  out.push(`datasets: ${manifest.length}`, "");

  // 1. model_usage rows across every flattened dataset: empty-output + aborted calls
  const callRows: {
    ds: string;
    provider: string;
    model: string;
    stop: string;
    out: number;
    inp: number;
  }[] = [];
  for (const ds of manifest) {
    const p = join(dir, `${ds.name}.jsonl`);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j.json_type !== "model_usage") continue;
        callRows.push({
          ds: ds.name,
          provider: j.json_provider ?? "-",
          model: j.json_model ?? "-",
          stop: j.json_stopReason ?? "-",
          out: j.json_usage_output ?? 0,
          inp: j.json_usage_input ?? 0,
        });
      } catch {
        /* skip */
      }
    }
  }
  const agg = new Map<
    string,
    { n: number; empty: number; aborted: number; out: number }
  >();
  for (const c of callRows) {
    const k = `${c.provider}/${c.model}`;
    const a = agg.get(k) ?? { n: 0, empty: 0, aborted: 0, out: 0 };
    a.n++;
    a.out += c.out;
    if (c.out <= 2 && c.stop === "stop") a.empty++;
    if (c.stop === "aborted") a.aborted++;
    agg.set(k, a);
  }
  out.push(
    "## model calls (empty-output = finish=stop but ≤2 output tokens = did nothing while claiming a turn)",
  );
  for (const [k, a] of agg)
    out.push(
      `- ${k}: calls=${a.n} empty=${a.empty} aborted=${a.aborted} total_out=${a.out}`,
    );
  out.push("");

  // 2. tool validation errors + error taxonomy per dataset
  for (const ds of manifest) {
    const p = join(dir, `${ds.name}.jsonl`);
    if (!existsSync(p)) continue;
    const errs: string[] = [];
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim() || !ERROR_RE.test(line)) continue;
      try {
        const j = JSON.parse(line);
        const raw = String(j._raw ?? "");
        const m = raw.match(/Validation failed for tool "([^"]+)"/);
        if (m) errs.push(`validation: ${m[1]}`);
        else if (/429/.test(raw)) errs.push("429");
        else if (/402/.test(raw)) errs.push("402");
        else if (/ENOENT/.test(raw)) errs.push("ENOENT");
      } catch {
        /* skip */
      }
    }
    if (errs.length) {
      const tally: Record<string, number> = {};
      for (const e of errs) tally[e] = (tally[e] ?? 0) + 1;
      out.push(`## ${ds.name} errors`);
      for (const [k, n] of Object.entries(tally)) out.push(`- ${k}: ${n}`);
      out.push("");
    }
  }

  // 3. claim-vs-reality scan over transcript text
  for (const ds of manifest) {
    const p = join(dir, `${ds.name}.jsonl`);
    if (!existsSync(p)) continue;
    const claims: string[] = [];
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j.json_type !== "message" || j.json_message_role !== "assistant")
          continue;
        const parts = JSON.parse(j.json_message_content ?? "[]") as {
          type: string;
          text?: string;
        }[];
        for (const part of parts) {
          if (part.type !== "text" || !part.text) continue;
          if (CLAIM_RE.test(part.text))
            claims.push(part.text.slice(0, 200).replaceAll("\n", " "));
        }
      } catch {
        /* skip */
      }
    }
    if (claims.length) {
      out.push(
        `## ${ds.name} assistant claims (cross-check each against artifacts before trusting)`,
      );
      for (const c of claims) out.push(`- "${c}"`);
      out.push("");
    }
  }
  return out.join("\n");
}
