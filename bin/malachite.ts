#!/usr/bin/env bun
// malachite — flatten + audit anything (tau DBs, session JSONLs, report bundles)
//   malachite flatten <outdir> <inputs...>   .db/.jsonl/.tar.gz -> flat csv+jsonl+manifest
//   malachite audit <flattened-dir>          verdicts: empty calls, errors, claim-vs-reality
// Replaces: kappa model-audit skill scripts + ad-hoc jq flattening.
import { flatten } from "../src/flatten.ts";
import { audit } from "../src/audit.ts";
import { runFindCli } from "../src/find.ts";
import { analyzeSse, sseVerdict } from "../src/sse.ts";

const PHASE_OK = (p: string) =>
  ["flatten", "find", "audit", "verdict"].includes(p);

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "flatten") {
  const [outdir, ...inputs] = rest;
  if (!outdir || !inputs.length) {
    console.error("usage: malachite flatten <outdir> <inputs...>");
    process.exit(1);
  }
  const datasets = flatten(inputs, outdir);
  for (const d of datasets)
    console.log(`${d.name}: ${d.rows} rows x ${d.cols} cols (${d.bytes}B)`);
  console.log(`\n${datasets.length} datasets -> ${outdir}/manifest.json`);
} else if (cmd === "audit") {
  const [dir] = rest;
  if (!dir) {
    console.error("usage: malachite audit <flattened-dir>");
    process.exit(1);
  }
  process.stdout.write(audit(dir));
} else if (cmd === "find") {
  const [dirOrBundle, ...extra] = rest;
  if (!dirOrBundle) {
    console.error("usage: malachite find <flattened-dir> | --bundle <tar.gz>");
    process.exit(1);
  }
  if (dirOrBundle === "--bundle" && extra[0]) {
    const { execFileSync } = await import("node:child_process");
    execFileSync(
      "bun",
      [
        import.meta.dir + "/malachite.ts",
        "flatten",
        "/tmp/kappa/malachite-find-bundle",
        extra[0],
      ],
      { stdio: "inherit" },
    );
    process.argv[2] = "/tmp/kappa/malachite-find-bundle";
    process.exit(runFindCli("/tmp/kappa/malachite-find-bundle"));
  } else {
    process.exit(runFindCli(dirOrBundle));
  }
} else if (cmd === "sse") {
  // malachite sse <raw-sse.txt | tau-report.tar.gz> [--json] [--explain]
  const input = rest.find((a) => !a.startsWith("--"));
  const flags = rest.filter((a) => a.startsWith("--"));
  if (!input) {
    console.error("usage: malachite sse <raw-sse.txt | tau-report.tar.gz> [--json] [--explain]");
    process.exit(1);
  }
  let text: string;
  if (input.endsWith(".tar.gz")) {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("tar", ["-xzOf", input, "raw-sse.txt"], {
      maxBuffer: 256 * 1024 * 1024,
    });
    text = out.toString("utf-8");
  } else {
    text = await Bun.file(input).text();
  }
  const report = analyzeSse(text);
  if (flags.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    process.stdout.write(sseVerdict(report));
  }
  if (flags.includes("--explain")) {
    // fluxling-transform deep integration: NL forensic narrative over findings
    try {
      const fluxling = await import(
        "/home/toxic/pens/flux/products/fluxling-transform/src/index.ts"
      );
      const narrative = await fluxling.chat([
        {
          role: "user",
          content:
            "You are a forensic auditor of LLM agent SSE captures. Explain what happened in this session stream, focusing on context drag, tool-call behavior, truncation, and capture loss. Be terse and concrete.\n\n" +
            JSON.stringify(report, null, 2).slice(0, 40000),
        },
      ]);
      console.log("\n--- fluxling explanation ---\n" + narrative);
    } catch (e) {
      console.error(`fluxling explain unavailable: ${e}`);
    }
  }
  process.exit(
    report.findings.some((f) => f.severity === "critical")
      ? 2
      : report.findings.length
        ? 1
        : 0,
  );
} else if (cmd === "chain") {
  const [phase, stateDir, ...inputs] = rest;
  if (!stateDir) {
    console.error(
      "usage: malachite chain [flatten|find|audit|verdict] <stateDir> [inputs...]",
    );
    process.exit(1);
  }
  const { runChain } = await import("../src/chain.ts");
  const state = runChain(
    PHASE_OK(phase) ? phase : undefined, // "all" or omitted = run remaining phases
    stateDir,
    inputs,
  );
  console.log(JSON.stringify(state, null, 2));
} else {
  console.error("usage: malachite flatten|audit|find|chain|sse ...");
  process.exit(1);
}
