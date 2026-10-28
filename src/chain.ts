// malachite chain — phased pipeline; each phase feeds the next via a state dir.
// Phase contract (hephaistos/corral drive one phase at a time):
//   0 flatten: inputs        -> <state>/flat/            (flat csv+jsonl+manifest)
//   1 find:    <state>/flat  -> <state>/find.json        (ranked findings)
//   2 audit:   <state>/flat  -> <state>/audit.md         (verdict report)
//   3 verdict: 1+2           -> <state>/verdict.json     (gate decision: go|block|critical)
// Every phase is idempotent and skips when its output exists (chain resume).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { flatten } from "./flatten.ts";
import { find } from "./find.ts";
import { audit } from "./audit.ts";

export const PHASES = ["flatten", "find", "audit", "verdict"] as const;
export type Phase = (typeof PHASES)[number];

export interface ChainState {
  inputs: string[];
  phase: Phase;
  datasets: number;
  findings: number;
  critical: boolean;
  verdict: "go" | "block" | "critical" | "clean";
}

export function runPhase(
  phase: Phase,
  stateDir: string,
  inputs?: string[],
): ChainState {
  mkdirSync(stateDir, { recursive: true });
  const statePath = join(stateDir, "chain-state.json");
  const prev: Partial<ChainState> = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : {};

  if (phase === "flatten") {
    if (!inputs?.length) throw new Error("flatten phase needs inputs");
    const flat = join(stateDir, "flat");
    const datasets = flatten(inputs, flat);
    prev.inputs = inputs;
    prev.datasets = datasets.length;
  }
  const flatDir = join(stateDir, "flat");

  if (phase === "find") {
    const findings = find(flatDir);
    writeFileSync(
      join(stateDir, "find.json"),
      JSON.stringify(findings, null, 2),
    );
    prev.findings = findings.length;
    prev.critical = findings[0] ? findings[0].score >= 9 : false;
  }

  if (phase === "audit") {
    writeFileSync(join(stateDir, "audit.md"), audit(flatDir));
  }

  if (phase === "verdict") {
    const findings = JSON.parse(
      readFileSync(join(stateDir, "find.json"), "utf8"),
    ) as { score: number; kind: string }[];
    const critical = findings[0] ? findings[0].score >= 9 : false;
    const emptyCalls = findings.some((f) => f.kind === "empty_output_calls");
    const claims = findings.some((f) => f.kind === "claim_vs_reality");
    prev.verdict = critical
      ? "critical"
      : emptyCalls || claims
        ? "block"
        : findings.length
          ? "go-with-findings"
          : "clean";
  }

  prev.phase = phase;
  const state: ChainState = {
    inputs: prev.inputs ?? [],
    phase,
    datasets: prev.datasets ?? 0,
    findings: prev.findings ?? 0,
    critical: prev.critical ?? false,
    verdict: prev.verdict ?? "clean",
  };
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  return state;
}

// chain [phase] <stateDir> <inputs...> — run ONE phase, or all remaining from state
export function runChain(
  phaseArg: string | undefined,
  stateDir: string,
  inputs?: string[],
): ChainState {
  const statePath = join(stateDir, "chain-state.json");
  const prev: Partial<ChainState> = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : {};
  const order: Phase[] = phaseArg
    ? [phaseArg as Phase]
    : PHASES.filter((p) => {
        const done = {
          flatten: existsSync(join(stateDir, "flat", "manifest.json")),
          find: existsSync(join(stateDir, "find.json")),
          audit: existsSync(join(stateDir, "audit.md")),
          verdict: prev.verdict !== undefined,
        } as Record<Phase, boolean>;
        return !done[p];
      });
  let last!: ChainState;
  for (const p of order)
    last = runPhase(p, stateDir, p === "flatten" ? inputs : undefined);
  return last;
}
