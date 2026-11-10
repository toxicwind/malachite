// malachite sse — hardcore forensic audit of tau report raw-sse.txt captures.
// Parses OpenAI-compatible chat.completion.chunk SSE streams and reports:
//   per-completion census (reasoning/content/toolcall chars, finish, usage,
//   cache), reconstructed tool calls, and weirdness findings:
//   zero-deliberation tool spam, truncated streams, context drag,
//   capture loss (tau-debug-dropped), all-work-no-answer turns.

export interface SseToolCall {
  id: string;
  name: string;
  args: string;
}

export interface SseCompletion {
  id: string;
  chunks: number;
  reasoningChars: number;
  contentChars: number;
  toolCalls: SseToolCall[];
  finishReason: string | null;
  usage: Record<string, number> | null;
}

export interface SseFinding {
  severity: "critical" | "warn" | "info";
  code: string;
  detail: string;
}

export interface SseReport {
  droppedRecords: number | null;
  droppedChars: number | null;
  completions: SseCompletion[];
  findings: SseFinding[];
  totals: {
    completions: number;
    chunks: number;
    reasoningChars: number;
    contentChars: number;
    toolCalls: number;
    promptTokensMax: number;
    cacheReadTokensMax: number;
  };
}

interface Chunk {
  id: string;
  choices?: Array<{
    delta?: {
      reasoning_content?: string | null;
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: Record<string, number> | null;
}

export function analyzeSse(text: string): SseReport {
  // capture-loss header: tau emits `: tau-debug-dropped records=N chars=M`
  let droppedRecords: number | null = null;
  let droppedChars: number | null = null;
  const dropMatch = text.match(
    /^:\s*tau-debug-dropped\s+records=(\d+)\s+chars=(\d+)/m,
  );
  if (dropMatch) {
    droppedRecords = Number(dropMatch[1]);
    droppedChars = Number(dropMatch[2]);
  }

  const byId = new Map<string, SseCompletion & { _acc: Map<number, SseToolCall> }>();
  let chunkCount = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    let c: Chunk;
    try {
      c = JSON.parse(line.slice(6));
    } catch {
      continue;
    }
    chunkCount++;
    const id = c.id ?? "unknown";
    let entry = byId.get(id);
    if (!entry) {
      entry = {
        id,
        chunks: 0,
        reasoningChars: 0,
        contentChars: 0,
        toolCalls: [],
        finishReason: null,
        usage: null,
        _acc: new Map(),
      };
      byId.set(id, entry);
    }
    entry.chunks++;
    const choice = c.choices?.[0];
    if (choice) {
      const d = choice.delta ?? {};
      entry.reasoningChars += (d.reasoning_content ?? "").length;
      entry.contentChars += (d.content ?? "").length;
      for (const tc of d.tool_calls ?? []) {
        const i = tc.index ?? 0;
        let acc = entry._acc.get(i);
        if (!acc) {
          acc = { id: "", name: "", args: "" };
          entry._acc.set(i, acc);
        }
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
      }
      if (choice.finish_reason) entry.finishReason = choice.finish_reason;
    }
    if (c.usage) entry.usage = c.usage;
  }

  const completions: SseCompletion[] = [...byId.values()].map((e) => ({
    id: e.id,
    chunks: e.chunks,
    reasoningChars: e.reasoningChars,
    contentChars: e.contentChars,
    toolCalls: [...e._acc.values()],
    finishReason: e.finishReason,
    usage: e.usage,
  }));

  const findings: SseFinding[] = [];
  if (droppedRecords !== null && droppedRecords > 0)
    findings.push({
      severity: "warn",
      code: "capture-loss",
      detail: `capture dropped ${droppedRecords} records (${droppedChars} chars) before this file — audit is PARTIAL, earlier turns invisible`,
    });

  for (const c of completions) {
    const rt = c.usage?.reasoning_tokens;
    if (c.finishReason === "tool_calls" && rt !== undefined && rt <= 2 && c.toolCalls.length > 0)
      findings.push({
        severity: "warn",
        code: "zero-deliberation-tool-call",
        detail: `${c.id}: finished tool_calls with reasoning_tokens=${rt} — reacted without thinking (context-drag signature)`,
      });
    if (!c.finishReason || !c.usage)
      findings.push({
        severity: "critical",
        code: "truncated-stream",
        detail: `${c.id}: stream ends with finish=${c.finishReason} usage=${c.usage ? "present" : "absent"} — capture or generation cut mid-stream`,
      });
  }

  // context drag: prompt-token growth across sequential completions
  const withUsage = completions.filter((c) => c.usage?.prompt_tokens);
  if (withUsage.length >= 2) {
    const first = withUsage[0].usage!.prompt_tokens;
    const last = withUsage[withUsage.length - 1].usage!.prompt_tokens;
    const growth = last - first;
    if (growth > 0)
      findings.push({
        severity: growth > 20000 ? "warn" : "info",
        code: "context-drag",
        detail: `prompt_tokens grew ${first} -> ${last} (+${growth}) across ${withUsage.length} calls; cache_read peaked at ${Math.max(...withUsage.map((c) => c.usage!.cache_read_tokens ?? 0))}`,
      });
  }

  const totalContent = completions.reduce((s, c) => s + c.contentChars, 0);
  const totalReasoning = completions.reduce((s, c) => s + c.reasoningChars, 0);
  const totalTools = completions.reduce((s, c) => s + c.toolCalls.length, 0);
  if (completions.length >= 3 && totalContent === 0 && totalTools > 0)
    findings.push({
      severity: "warn",
      code: "all-work-no-answer",
      detail: `${completions.length} completions, ${totalTools} tool calls, ${totalReasoning} reasoning chars, ZERO user-visible content — the loop worked without ever answering`,
    });

  const promptMax = Math.max(0, ...completions.map((c) => c.usage?.prompt_tokens ?? 0));
  const cacheMax = Math.max(0, ...completions.map((c) => c.usage?.cache_read_tokens ?? 0));

  return {
    droppedRecords,
    droppedChars,
    completions,
    findings,
    totals: {
      completions: completions.length,
      chunks: chunkCount,
      reasoningChars: totalReasoning,
      contentChars: totalContent,
      toolCalls: totalTools,
      promptTokensMax: promptMax,
      cacheReadTokensMax: cacheMax,
    },
  };
}

export function sseVerdict(r: SseReport): string {
  const lines: string[] = [];
  lines.push(
    `sse: ${r.totals.completions} completions, ${r.totals.chunks} chunks, ${r.totals.toolCalls} tool calls`,
  );
  lines.push(
    `tokens: prompt(max)=${r.totals.promptTokensMax} cache_read(max)=${r.totals.cacheReadTokensMax} | chars: reasoning=${r.totals.reasoningChars} content=${r.totals.contentChars}`,
  );
  if (r.droppedRecords)
    lines.push(`capture: DROPPED ${r.droppedRecords} records / ${r.droppedChars} chars (partial audit)`);
  for (const f of r.findings) lines.push(`[${f.severity.toUpperCase()}] ${f.code}: ${f.detail}`);
  for (const c of r.completions) {
    const tools = c.toolCalls.map((t) => `${t.name}(${t.args.length}B args)`).join(", ") || "none";
    lines.push(
      `  ${c.id.slice(8, 20)} chunks=${c.chunks} reasoning=${c.reasoningChars} content=${c.contentChars} finish=${c.finishReason} tools=[${tools}]`,
    );
  }
  const crit = r.findings.filter((f) => f.severity === "critical").length;
  lines.push(`verdict: ${crit > 0 ? "CRITICAL" : r.findings.length ? "FINDINGS" : "clean"} (${r.findings.length} findings)`);
  return lines.join("\n") + "\n";
}
