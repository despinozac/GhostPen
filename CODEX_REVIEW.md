# GhostPen Memory Safety & Resource Review

Cleaned review of `AGY_REVIEW.md`, checked against the current checkout on
2026-10-16. This document corrects stale code references, separates demonstrated
defects from conditional hardening, and accounts for the LLM helper's process
lifetime. It is a validation of the original findings, not a new exhaustive audit.

## Validation and limits

- Inspected the relevant Zig and React implementations and their current callers.
- Checked the pinned llama.cpp dependency's threadpool ownership behavior.
- Reproduced the WAV chunk-cursor overflow in an isolated test with Zig 0.16.0.
- Did not run the full application, allocation-failure injection, malformed-file
  integration tests, or hidden-window performance measurements.
- No implementation changes are included in this review.

## 1. Confirmed defects

### 1.1 WAV chunk-cursor overflow

**Severity:** Medium — malformed-input crash; incorrect cursor progression in
builds without runtime safety.

**Location:** `src/wav.zig`, `info`.

```zig
at += 8 + len + (len & 1);
```

The right-hand arithmetic is evaluated as `u32` before conversion to the `u64`
cursor. Chunk lengths starting at `0xFFFF_FFF7` overflow. An isolated reproduction
with `len = 0xFFFF_FFFF` panicked on integer overflow under Zig 0.16.0. Without
runtime safety, wrapping can prevent the cursor from advancing, including an
infinite loop for some lengths.

**Recommended fix:** Widen before addition:

```zig
at += 8 + @as(u64, len) + (@as(u64, len) & 1);
```

Keep malformed-chunk validation explicit; the widening addresses this particular
overflow, not every possible malformed WAV.

### 1.2 Excessive WAV channel counts can stall the meeting worker

**Severity:** Medium — malformed-input denial of service.

**Location:** `src/wav.zig`, `info` and `readChannel`.

`info` accepts nonzero channel counts up to the `u16` limit. In `readChannel`:

```zig
const block: usize = @as(usize, i.channels) * 2;
var buf: [64 * 1024]u8 = undefined;
const per = buf.len / block;
```

For more than 32768 channels, `per` is zero. If at least one complete frame is
present and requested, the loop reads zero bytes and never advances `done`.
Current transcription callers limit the selected channel index, but still pass
the original channel count into this calculation.

**Recommended fix:** Reject unsupported channel counts in `info`, and make
`readChannel` reject a zero channel count, an invalid selected channel, or a frame
larger than its buffer before calculating frame counts or entering the loop.
Choose the supported channel limit from the application's actual requirements.

### 1.3 Partial job allocations leak, and worker-start failure strands jobs

**Severity:** Medium — allocation leaks and stalled meeting processing on failure.

**Location:** `src/meetings.zig`, `enqueueJob`.

The job's `root`, `id`, `prompt`, and `note` are duplicated sequentially. Failure
of a later allocation or `queue.append` leaves earlier allocations unfreed.
If thread creation fails after appending, the job remains queued with no worker.
Retrying the same non-question job may hit the duplicate check and return without
attempting to start a worker, leaving the job stuck until another distinct job
triggers a successful start.

**Recommended fix:** Construct the owned job in an error-returning helper with
`errdefer` cleanup, then explicitly transfer ownership to the queue. Alternatively,
use `defer` with a transfer flag. On worker-start failure, roll back the appended
job and free its fields, and expose or record a retryable failure state.

Adding `errdefer` directly to the existing `void` function does not fix its
`catch return` paths: those are normal returns, not error returns.

### 1.4 Remembered-plan parsing loses allocations

**Severity:** Low — bounded to one helper process's startup lookup in the current
lifecycle.

**Location:** `src/llm_helper.zig`, `planRemembered`.

`std.json.parseFromSliceLeaky` receives `plan_gpa` directly, so parser-owned arrays
and any strings requiring allocation are never explicitly released. The adjacent
`planRemember` and `planForget` functions already use temporary arenas.

**Recommended fix:** Parse through a temporary arena, or use `parseFromSlice` and
deinitialize its result. The returned `Remembered` contains scalar values, so it
does not need to retain the parsed storage.

The model loads once per helper process. Unloading the runner terminates that
process, so this does not accumulate across model reloads in the main application.

### 1.5 ChatModel does not release its native threadpool

**Severity:** Low in the current helper-process lifecycle — missing native
resource cleanup.

**Location:** `src/llm_helper.zig`, `ChatModel.load` and `ChatModel.deinit`.

`ChatModel.load` creates a `ggml_threadpool` and attaches it to the llama context
without storing the handle in `ChatModel`. The attachment is non-owning;
`llama_free` does not free that pool. `ChatModel.deinit` therefore omits the pool
and its worker threads.

**Recommended fix:** Store the nullable threadpool handle and free it after the
llama context has been freed, before backend shutdown. Preserve ownership and
cleanup on any future early-return paths after creation.

The current `loadVision` failure path falls back to text-only operation; it does
not abort model loading. `ChatModel.load` returns an optional value, so `errdefer`
would not execute on a `return null` path. Use cleanup appropriate to that return
type if such a path is added.

Model unloading kills the helper process, which reclaims its memory and threads.
Repeated reloads therefore do not accumulate these pools in the parent process.

### 1.6 Engine and CLI allocations lack explicit shutdown cleanup

**Severity:** Low — retained allocations within the helper process.

**Location:** `src/llm_helper.zig`, `main`, `controlTexts`, and `Engine.cached`.

`controlTexts` transfers an allocated list of borrowed vocabulary-string slices
into `specials.texts`. The list backing allocation is not released. `cached`
retains its token buffer for prompt reuse and also lacks shutdown cleanup. There
is no current `Engine.deinit` implementation; the original report's reference to
one was stale.

CLI string options allocated with `dupeZ` are not explicitly freed on shutdown,
and repeated flags overwrite prior owned allocations.

**Recommended fix:** Retain enough ownership information to release the
`controlTexts` list correctly, deinitialize the token cache after joining the
generation worker, and track owned CLI strings for replacement and final cleanup.
The strings referenced by the control-text list are borrowed and must not be
individually freed. Cache capacity retained for reuse is intentional during
normal operation; the missing release is at shutdown.

### 1.7 STT bind allocation is lost on startup failure

**Severity:** Low — one-time startup allocation leak.

**Location:** `src/stt_server.zig`, `maybeStart` and `serve`.

`bind` is allocated before parsing and thread creation. It is not freed if either
fails, or if `serve` exits while preloading or opening the listener. While the
server runs successfully, retaining the string for logging is expected.

**Recommended fix:** Keep ownership in `maybeStart` until the thread starts, then
transfer it to `serve`, which should free it when that function returns.

The global `config` requires separate treatment. `modelOverride()` remains
accessible outside the server thread, so its strings are not simply unreachable
on startup failure. Any cleanup must reset or synchronize all readers. Also,
`config.language` can fall back to the literal `"auto"`; cleanup must distinguish
owned memory from that literal.

### 1.8 Meeting playback repeatedly rebinds the keyboard listener

**Severity:** Low — avoidable listener and closure churn.

**Location:** `frontend/src/Meetings.tsx`, playback and keyboard effects.

The playback effect updates the displayed time through `requestAnimationFrame`.
The keyboard effect has no dependency array, so each render removes and recreates
its listener. The cleanup prevents listener accumulation; this is a performance
issue rather than a listener leak. Its frequency follows actual rendering and
browser scheduling, rather than a guaranteed 60 Hz.

**Recommended fix:** Use stable callbacks with their correct dependencies, or
read current playback state through refs. Adding an empty dependency array alone
can leave handlers using stale state.

### 1.9 Dictation schedules animation frames while idle

**Severity:** Low — avoidable animation work when callbacks are delivered.

**Location:** `frontend/src/Dictation.tsx`, waveform effect.

The effect schedules its next animation frame unconditionally. Outside
transcription and proofreading, it continues calculating and assigning bar
heights even in idle, done, and error phases.

**Recommended fix:** Animate while listening and during a bounded decay period,
then settle the bars once and stop. Restart the loop on the next relevant phase
transition. Preserve the existing busy-state shimmer behavior.

The original assertion of continuous 60 FPS activity in a hidden window was not
validated. Actual hidden-window scheduling depends on the embedded browser and
visibility handling; measure it before claiming that cost.

## 2. Conditional issues and optional hardening

### 2.1 Validate the selected WAV channel at the reader boundary

**Location:** `src/wav.zig`, `readChannel`.

The function does not validate `channel < i.channels`. Invalid input can read
another frame, unread buffer contents, or beyond the stack buffer for a full
batch. Runtime safety can turn an out-of-bounds access into a panic.

Both current callers select valid channel indices: transcription iterates over
at most the first two available channels, and speaker analysis selects channel 1
only when more than one channel exists. No current invalid-channel call path was
identified. Add validation as part of the WAV reader fix, but do not present this
as a demonstrated exploitable path through existing callers.

### 2.2 Duplicate monitor names could overwrite an allocation

**Location:** `src/captions.zig`, `defaultSinkMonitor`.

If multiple source entries match the default sink's monitor name, assigning
another `dupeZ` result to `found` loses the prior allocation. Duplicate matching
entries were not demonstrated from the audio backend.

**Recommended hardening:** Return immediately after the first successful match,
or break after assigning `found`.

### 2.3 Make notification body lifetime explicit

**Location:** `src/updates.zig`, `notify`.

Current code copies a context into `oriel.App.runOnMain`; it does not create the
detached thread shown in the original report. The context retains a borrowed
body slice, but both current callers supply string literals with static lifetime.
No current use-after-free was identified.

**Recommended hardening:** Require a compile-time body string, or copy the body
into the scheduled context if dynamic messages are needed. A fixed buffer avoids
adding heap-cleanup obligations for tasks dropped during shutdown.

## 3. Finding removed from the active defect list

### Original 1.2: unchecked WAV decoder chunk addition

The quoted implementation is outdated. Current `src/models.zig:decodeWav` uses:

```zig
const body_end = std.math.add(usize, body_start, size) catch return error.BadWav;
if (body_end > data.len) return error.BadWav;
```

This already rejects addition overflow and chunks extending beyond the input.
Do not replace it with saturating arithmetic that silently clips malformed
chunks. Padding and loop-bound arithmetic may be reviewed separately, but the
original report does not demonstrate a remaining failure in those expressions.

## Suggested implementation order

1. Fix WAV cursor arithmetic and reader validation; verify malformed chunk sizes,
   excessive channel counts, and invalid selected channels.
2. Fix job construction ownership and worker-start rollback; verify allocation
   failure and retry behavior.
3. Add helper and STT ownership cleanup with correct shutdown ordering.
4. Reduce frontend animation and listener churn while preserving current state
   and transition behavior.
5. Apply optional monitor and notification lifetime hardening.
