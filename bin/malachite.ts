#!/usr/bin/env bun
// malachite — flatten + audit anything (tau DBs, session JSONLs, report bundles)
//   malachite flatten <outdir> <inputs...>   .db/.jsonl/.tar.gz -> flat csv+jsonl+manifest
//   malachite audit <flattened-dir>          verdicts: empty calls, errors, claim-vs-reality
// Replaces: kappa model-audit skill scripts + ad-hoc jq flattening.
import { flatten } from "../src/flatten.ts";
import { audit } from "../src/audit.ts";
import { runFindCli } from "../src/find.ts";

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
} else {
  console.error("usage: malachite flatten|audit ...");
  process.exit(1);
}
