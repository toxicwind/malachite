# malachite — flatten + audit anything (geode inference plane)

Green mineral, green lights that are actually green. Replaces the ad-hoc
`model-audit` skill scripts (`usable-models-audit.ts`, `tau-session-audit.ts`)
and every hand-rolled jq flattening session.

## What it does

1. **flatten** — any mix of sqlite `.db`, `.jsonl`, and tau/kappa report
   bundles (`.tar.gz`) → flat, untruncated CSV + JSONL per table/transcript,
   with a `manifest.json`. Deep-flattens nested JSON into `prefix_col`
   columns; arrays inlined as JSON strings. Zero deps (bun:sqlite + node fs).
2. **audit** — verdicts over a flattened dir:
   - **empty-output calls**: `finish=stop` with ≤2 output tokens — a model
     turn that did nothing while the session kept claiming progress
     (the qwen3.6-35b signature: `calls=5 empty=3 aborted=2 total_out=6`).
   - **error taxonomy**: 402/429/401/403/ENOENT/`Validation failed for tool` tallies.
   - **claim-vs-reality**: assistant text claims (verified/healthy/done/fixed)
     listed for cross-check against artifacts — declared ≠ observed.

## Usage

```bash
malachite flatten /tmp/flat ~/.tau/agent/agent.db ~/.tau/agent/history.db ~/.tau/reports/tau-report-*.tar.gz
malachite audit /tmp/flat
```

## Evidence receipt (2026-10-28)

Built to audit the tau report bundle `tau-report-2026-10-28T19-54-54-629Z`:
qwen3.6-35b emitted 6 output tokens across 5 captured calls while the session
claimed "all three surfaces healthy" with verify items still pending, and the
transcript carried 68×402 + 20×429 errors. That is the exact failure class
this product exists to catch mechanically.

## find (v2) — dynamic "find the error" over ANY bundle

`malachite find --bundle <tar.gz>`: flatten + ensemble detection, no training data,
no hardcoded schema — features derived from whatever the bundle contains:
error-pattern densities w/ retry-loop detection (402/429/401/403/ENOENT/crash/
daemon-exit/timeout/DNS), IQR numeric outliers, empty-output model calls, parse
corruption, and claim-vs-reality. Ranked findings; exit 2 = critical (>=9),
1 = findings, 0 = clean. Verified on an unseen hephaistos-class bundle
(daemon ENOENT spawn-fail loop + panic + false "verified healthy" claim).
