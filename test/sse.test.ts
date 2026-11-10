import { describe, test, expect } from "bun:test";
import { analyzeSse, sseVerdict } from "../src/sse.ts";

const chunk = (id: string, delta: object, extra: object = {}) =>
  `data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null, ...extra }] })}\n\n`;

describe("malachite sse", () => {
  test("census: groups chunks by completion id and reconstructs tool calls", () => {
    const A = "chatcmpl-aaa";
    const text =
      `: tau-debug-dropped records=4709 chars=1452850\n` +
      chunk(A, { reasoning_content: "think " }) +
      chunk(A, { reasoning_content: "more" }) +
      chunk(A, { tool_calls: [{ index: 0, id: "call_1", function: { name: "grep", arguments: '{"pat' } }] }) +
      chunk(A, { tool_calls: [{ index: 0, function: { arguments: 'tern":"x"}' } }] }, { finish_reason: "tool_calls" }) +
      `data: ${JSON.stringify({ id: A, choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: 96763, completion_tokens: 100, reasoning_tokens: 42, cache_read_tokens: 96000 } })}\n\n`;
    const r = analyzeSse(text);
    expect(r.droppedRecords).toBe(4709);
    expect(r.totals.completions).toBe(1);
    expect(r.totals.chunks).toBe(5);
    expect(r.completions[0].reasoningChars).toBe("think more".length);
    expect(r.completions[0].toolCalls[0].name).toBe("grep");
    expect(r.completions[0].toolCalls[0].args).toBe('{"pattern":"x"}');
    expect(r.completions[0].finishReason).toBe("tool_calls");
    expect(r.completions[0].usage?.prompt_tokens).toBe(96763);
    // capture-loss finding present
    expect(r.findings.some((f) => f.code === "capture-loss")).toBe(true);
    // no zero-deliberation (reasoning_tokens=42)
    expect(r.findings.some((f) => f.code === "zero-deliberation-tool-call")).toBe(false);
  });

  test("zero-deliberation tool spam: reasoning_tokens<=2 with tool_calls flags", () => {
    const A = "chatcmpl-bbb";
    const text =
      chunk(A, { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: "{}" } }] }, { finish_reason: "tool_calls" }) +
      `data: ${JSON.stringify({ id: A, choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: 98202, completion_tokens: 119, reasoning_tokens: 1, cache_read_tokens: 97792 } })}\n\n`;
    const r = analyzeSse(text);
    expect(r.findings.some((f) => f.code === "zero-deliberation-tool-call")).toBe(true);
  });

  test("truncated stream: no finish_reason and no usage is critical", () => {
    const A = "chatcmpl-ccc";
    const text = chunk(A, { reasoning_content: "cut off mid" });
    const r = analyzeSse(text);
    expect(r.findings.some((f) => f.code === "truncated-stream" && f.severity === "critical")).toBe(true);
    expect(sseVerdict(r)).toContain("CRITICAL");
  });

  test("context drag: prompt growth across calls reported", () => {
    const mk = (id: string, prompt: number) =>
      chunk(id, {}) +
      `data: ${JSON.stringify({ id, choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: prompt, completion_tokens: 10, reasoning_tokens: 5, cache_read_tokens: prompt - 100 } })}\n\n`;
    const text = mk("c1", 90000) + mk("c2", 95000) + mk("c3", 103000);
    const r = analyzeSse(text);
    expect(r.totals.promptTokensMax).toBe(103000);
    const drag = r.findings.find((f) => f.code === "context-drag");
    expect(drag).toBeDefined();
    expect(drag!.detail).toContain("+13000");
  });

  test("all-work-no-answer: many tool calls, zero content", () => {
    const mk = (id: string, name: string) =>
      chunk(id, { tool_calls: [{ index: 0, id: "x", function: { name, arguments: "{}" } }] }, { finish_reason: "tool_calls" }) +
      `data: ${JSON.stringify({ id, choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: 1000, completion_tokens: 10, reasoning_tokens: 500, cache_read_tokens: 900 } })}\n\n`;
    const r = analyzeSse(mk("c1", "find") + mk("c2", "grep") + mk("c3", "read"));
    expect(r.findings.some((f) => f.code === "all-work-no-answer")).toBe(true);
  });

  test("clean stream with content: no findings, verdict clean", () => {
    const A = "chatcmpl-ddd";
    const text =
      chunk(A, { reasoning_content: "ok" }) +
      chunk(A, { content: "answer" }, { finish_reason: "stop" }) +
      `data: ${JSON.stringify({ id: A, choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: 1000, completion_tokens: 10, reasoning_tokens: 5, cache_read_tokens: 900 } })}\n\n`;
    const r = analyzeSse(text);
    expect(r.findings.length).toBe(0);
    expect(sseVerdict(r)).toContain("clean");
  });
});
