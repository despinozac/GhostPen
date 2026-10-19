// The inline reasoning markers recognized by src/ai.zig's stripReasoning.
// Summary keeps the raw stream so thinking can be shown or hidden at any time.
const BLOCKS = [
  ["<think>", "</think>"],
  ["<reasoning>", "</reasoning>"],
  ["<|channel>thought", "<channel|>"],
] as const;

const GEMMA_END = "<channel|>";
// Gemma can continue the thought channel prefilled by its chat template
// without emitting <|channel>thought. Its visible heading is ordinary
// Markdown; recognize it only at the beginning, never in the article body.
const THINKING_HEADING = /^\s*(?:#{1,6}[ \t]+)?(?:\*\*|__)?Thinking Process(?::(?:\*\*|__)?|(?:\*\*|__):)[ \t]*/i;
const HEADING_PREFIXES = [
  "thinking process:", "**thinking process:**", "**thinking process**:",
  "__thinking process:__", "__thinking process__:",
];

function isPartialThinkingHeading(raw: string): boolean {
  const prefix = raw.trimStart().replace(/^#{1,6}[ \t]*/, "").toLowerCase();
  return HEADING_PREFIXES.some((heading) => heading.startsWith(prefix));
}

// A marker may arrive over several chunks. Hold its trailing prefix back
// until we know whether it is a marker, so it never flashes in the summary.
function withoutPartialMarker(text: string, markers: readonly string[]): string {
  let held = 0;
  for (const marker of markers) {
    for (let n = 1; n < marker.length && n <= text.length; n++) {
      if (text.endsWith(marker.slice(0, n))) held = Math.max(held, n);
    }
  }
  return held ? text.slice(0, -held) : text;
}

export function splitSummaryThinking(raw: string): { summary: string; thinking: string } {
  const summary: string[] = [];
  const thinking: string[] = [];
  let cursor = 0;
  const heading = THINKING_HEADING.exec(raw);
  const gemmaEnd = raw.indexOf(GEMMA_END);
  const hasOpenerBeforeEnd = BLOCKS.some(([open]) => {
    const at = raw.indexOf(open);
    return at !== -1 && at < gemmaEnd;
  });
  // A closing channel token without an opener also identifies an implicit
  // thought channel in a completed response (even without the heading).
  if (heading || (gemmaEnd !== -1 && !hasOpenerBeforeEnd)) {
    const start = heading?.[0].length ?? 0;
    if (gemmaEnd === -1) {
      return { summary: "", thinking: withoutPartialMarker(raw.slice(start), [GEMMA_END]).trim() };
    }
    thinking.push(raw.slice(start, gemmaEnd));
    cursor = gemmaEnd + GEMMA_END.length;
  } else if (isPartialThinkingHeading(raw)) {
    // Hold "Thi…" (and Markdown decoration) until the opening is known.
    return { summary: "", thinking: "" };
  }
  while (cursor < raw.length) {
    let start = -1;
    let block: (typeof BLOCKS)[number] | undefined;
    for (const candidate of BLOCKS) {
      const at = raw.indexOf(candidate[0], cursor);
      if (at !== -1 && (start === -1 || at < start)) {
        start = at;
        block = candidate;
      }
    }
    if (!block) {
      summary.push(withoutPartialMarker(raw.slice(cursor), BLOCKS.map(([open]) => open)));
      break;
    }
    summary.push(raw.slice(cursor, start));
    const contentStart = start + block[0].length;
    const end = raw.indexOf(block[1], contentStart);
    if (end === -1) {
      thinking.push(withoutPartialMarker(raw.slice(contentStart), [block[1]]));
      break;
    }
    thinking.push(raw.slice(contentStart, end));
    cursor = end + block[1].length;
  }
  return { summary: summary.join("").trim(), thinking: thinking.map((s) => s.trim()).filter(Boolean).join("\n\n") };
}
