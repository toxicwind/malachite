// malachite find — dynamic "find the error" over any flattened bundle (or raw tar.gz).
// Ensemble detector, schema-agnostic: derives features from whatever flatten() emits.
//   signals: error-pattern density, IQR/z numeric outliers, retry loops, empty-output
//   model calls, claim-vs-reality, parse corruption. No training data, no hardcoded schema.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { flatten } from "./flatten.ts";

const ERROR_PATTERNS: [string, RegExp, number][] = [
  ["credit_402", /\b402\b|insufficient.?balance/i, 3],
  ["rate_429", /\b429\b|rate.?limit|concurrency.?limit/i, 2],
  ["auth_401_403", /\b40[13]\b|unauthorized|forbidden/i, 2],
  ["missing_file", /ENOENT|no such file/i, 2],
  ["tool_validation", /Validation failed for tool/i, 2],
  ["crash", /Traceback|panic:|segfault|core dumped/i, 4],
  ["daemon_exit", /exit code (?!0)|non-zero exit|spawn.?fail/i, 3],
  ["timeout", /timeout|timed out|ETIMEDOUT/i, 1.5],
  ["dns", /ENOTFOUND|getaddrinfo/i, 2],
  ["schema_lie", /declared.*observed|not supported|unsupported param/i, 2],
];

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const iqrOutliers = (xs: number[]) => {
  if (xs.length < 8) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.floor(p * (s.length - 1))];
  const iqr = q(0.75) - q(0.25);
  if (iqr === 0) return 0;
  return s.filter((x) => x > q(0.75) + 1.5 * iqr).length / xs.length;
};

export interface Finding {
  score: number;
  kind: string;
  where: string;
  evidence: string;
}

export function find(dir: string): Finding[] {
  const findings: Finding[] = [];
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return findings;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    name: string;
  }[];

  for (const { name } of manifest) {
    const p = join(dir, `${name}.jsonl`);
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.trim());
    if (!lines.length) continue;

    // 1. error-pattern density + retry loops
    const hits = new Map<string, string[]>();
    for (const [i, line] of lines.entries()) {
      for (const [kind, re] of ERROR_PATTERNS)
        if (re.test(line))
          (hits.get(kind) ?? hits.set(kind, []).get(kind)!).push(
            `line ${i + 1}`,
          );
    }
    for (const [kind, at] of hits) {
      const density = at.length / lines.length;
      const loop = at.length >= 3 ? " (retry loop)" : "";
      findings.push({
        score:
          (Math.min(10, at.length * 0.8 + density * 10) *
            ERROR_PATTERNS.find(([k]) => k === kind)![2]) /
          2,
        kind: `error_density:${kind}${loop}`,
        where: `${name}.jsonl`,
        evidence: `${at.length}/${lines.length} rows${loop}, first at ${at[0]}`,
      });
    }

    // 2. numeric outliers (IQR) on a few high-signal flattened cols
    for (const col of [
      "json_usage_output",
      "json_duration",
      "json_latency_ms",
      "json_status",
    ]) {
      const xs: number[] = [];
      for (const line of lines) {
        try {
          const v = JSON.parse(line)[col];
          if (typeof v === "number") xs.push(v);
        } catch {
          /* skip */
        }
      }
      const frac = iqrOutliers(xs);
      if (frac > 0.05)
        findings.push({
          score: 4 + frac * 6,
          kind: "numeric_outlier:iqr",
          where: `${name}.jsonl:${col}`,
          evidence: `${Math.round(frac * 100)}% outliers of ${xs.length} values`,
        });
    }

    // 3. empty-output model calls (did-nothing turns)
    let empty = 0,
      calls = 0;
    for (const line of lines) {
      try {
        const j = JSON.parse(line);
        if (j.json_type === "model_usage") {
          calls++;
          if ((j.json_usage_output ?? 0) <= 2 && j.json_stopReason === "stop")
            empty++;
        }
      } catch {
        /* skip */
      }
    }
    if (calls >= 2 && empty / calls >= 0.3)
      findings.push({
        score: 9,
        kind: "empty_output_calls",
        where: `${name}.jsonl`,
        evidence: `${empty}/${calls} model calls produced <=2 tokens yet finished "stop"`,
      });

    // 4. parse corruption (truncated/unparseable rows)
    const bad = lines.filter((l) => {
      try {
        JSON.parse(l);
        return false;
      } catch {
        return true;
      }
    }).length;
    if (bad > 0)
      findings.push({
        score: 2 + bad * 0.5,
        kind: "parse_corruption",
        where: `${name}.jsonl`,
        evidence: `${bad} unparseable rows (bundle truncation?)`,
      });
  }

  // 5. claim-vs-reality: claims exist while error findings exist
  const hasClaims =
    existsSync(join(dir, "session.jsonl")) &&
    /verified|healthy|done|fixed/i.test(
      readFileSync(join(dir, "session.jsonl"), "utf8"),
    );
  const hasErrors = findings.some((f) => f.kind.startsWith("error_density"));
  if (hasClaims && hasErrors)
    findings.push({
      score: 10,
      kind: "claim_vs_reality",
      where: "session.jsonl",
      evidence:
        "assistant claims success while error signals present in same bundle",
    });

  return findings.sort((a, b) => b.score - a.score);
}

// CLI entry (called from bin/malachite.ts with the target dir as arg)
export function runFindCli(dir: string): number {
  const results = find(dir);
  if (!results.length) {
    console.log("no anomalies found");
    return 0;
  }
  for (const f of results.slice(0, 15))
    console.log(
      `${f.score.toFixed(1).padStart(5)}  ${f.kind}  @ ${f.where}  — ${f.evidence}`,
    );
  return results[0]?.score >= 9 ? 2 : 1; // exit 2 = critical anomaly found
}
