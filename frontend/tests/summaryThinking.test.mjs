import assert from "node:assert/strict";
import test from "node:test";
import { splitSummaryThinking } from "../src/summaryThinking.ts";

test("ordinary summaries, Markdown and less-than signs are preserved", () => {
  const summary = "## Key ideas\n\n- 2 < 3\n- **Thinking** is the article's topic.\n\n`<div>`";
  assert.deepEqual(splitSummaryThinking(summary), { summary, thinking: "" });
  assert.deepEqual(splitSummaryThinking(""), { summary: "", thinking: "" });
});

for (const [open, close] of [
  ["<think>", "</think>"],
  ["<reasoning>", "</reasoning>"],
  ["<|channel>thought", "<channel|>"],
]) {
  test(`${open}: separate thinking from the completed summary`, () => {
    assert.deepEqual(splitSummaryThinking(`${open}\nPlan the answer.\n${close}\n## Summary\n\nThe key point.`), {
      summary: "## Summary\n\nThe key point.", thinking: "Plan the answer.",
    });
  });

  test(`${open}: no thinking or marker fragments leak at any chunk boundary`, () => {
    const hidden = `${open}Private reasoning${close}`;
    // Every prefix can be a paused stream, a reopened window's snapshot,
    // or the last chunk received before cancellation.
    for (let n = 1; n <= hidden.length; n++) {
      const result = splitSummaryThinking(`Intro. ${hidden.slice(0, n)}`);
      assert.equal(result.summary, "Intro.", `prefix ${n}`);
      assert.ok(!result.thinking.includes("<"), `partial closing marker at ${n}`);
    }
    assert.deepEqual(splitSummaryThinking(`Intro. ${hidden} The answer.`), {
      summary: "Intro.  The answer.", thinking: "Private reasoning",
    });
  });

  test(`${open}: unfinished thinking remains separate after stopping`, () => {
    assert.deepEqual(splitSummaryThinking(`Intro. ${open}Still working`), {
      summary: "Intro.", thinking: "Still working",
    });
  });
}

test("multiple marker formats retain their original order", () => {
  assert.deepEqual(splitSummaryThinking("<reasoning>First</reasoning>A <think>Second</think>B<|channel>thoughtThird<channel|> C"), {
    summary: "A B C", thinking: "First\n\nSecond\n\nThird",
  });
});

test("a partial opener is released when it turns out to be ordinary text", () => {
  assert.equal(splitSummaryThinking("A <thi").summary, "A");
  assert.equal(splitSummaryThinking("A <thing> example").summary, "A <thing> example");
});

test("empty reasoning blocks leave the answer intact", () => {
  assert.deepEqual(splitSummaryThinking("<think>\n\n</think>\nThe answer."), {
    summary: "The answer.", thinking: "",
  });
});

// Excerpts from the reported Gemma 4 response: the opening channel token
// was absent, and the closing token directly preceded the first bullet.
const gemmaThinking = `Analyze the Request: The user wants me to summarize a provided web document about Anthropic's stance on AI consciousness. The summary must adhere strictly to a specific format:
Opening paragraph (2-3 sentences): What it is and why it's worth reading.
## Key points heading with a compact bulleted list (one line per point).
## Details heading with 2-5 short paragraphs/sub-lists following the document

Final Polish. (This leads to the final output.)`;
const gemmaSummary = '- Tech leaders are increasingly treating Artificial Intelligence as if it could possess feelings, a concept that Anthropic is actively exploring through policies regarding "model welfare." This discussion carries profound implications for society, touching upon ethics, safety, and what it means to be human.';

for (const heading of ["Thinking Process:", "**Thinking Process:**", "**Thinking Process**:", "__Thinking Process:__", "## Thinking Process:"]) {
  test(`Gemma implicit thought channel (${heading}) stays hidden at every streaming boundary`, () => {
    const hidden = `${heading}\n\n${gemmaThinking}<channel|>`;
    for (let n = 1; n <= hidden.length; n++) {
      assert.equal(splitSummaryThinking(hidden.slice(0, n)).summary, "", `prefix ${n}`);
    }
    assert.deepEqual(splitSummaryThinking(hidden + gemmaSummary), {
      summary: gemmaSummary, thinking: gemmaThinking,
    });
    for (let n = 1; n <= gemmaSummary.length; n++) {
      assert.equal(splitSummaryThinking(hidden + gemmaSummary.slice(0, n)).summary, gemmaSummary.slice(0, n).trim());
    }
  });
}

test("an implicit Gemma channel can be recovered from a snapshot without a heading", () => {
  assert.deepEqual(splitSummaryThinking(gemmaThinking + "<channel|>" + gemmaSummary), {
    summary: gemmaSummary, thinking: gemmaThinking,
  });
});

test("an unfinished implicit thought channel remains available only as thinking", () => {
  assert.deepEqual(splitSummaryThinking("Thinking Process:\n\n" + gemmaThinking + "<chan"), {
    summary: "", thinking: gemmaThinking,
  });
});

test("ordinary discussion of thinking is preserved, including headings inside the summary", () => {
  for (const summary of [
    "Thinking processes differ between people.",
    "## Thinking skills\n\nA useful article.",
    "The article describes a method.\n\nThinking Process:\n\nStart by reviewing the evidence.",
    "**Thoughtful** writing matters.",
  ]) assert.deepEqual(splitSummaryThinking(summary), { summary, thinking: "" });
});
