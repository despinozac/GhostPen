# GhostPen Memory Safety & Resource Leak Audit

This document summarizes findings from a full audit of the GhostPen backend (`src/*.zig`), its C/C++ FFI boundaries (`llama.cpp`, `whisper.cpp`, `oriel`), and the React frontend (`frontend/src/*`) for memory leaks, out-of-bounds accesses, integer overflows, use-after-free, double-free, and concurrency/lifetime hazards.

---

## 1. Memory Safety & Security Defects (OOB Read, Integer Overflow, DoS)

### 1.1 Out-of-Bounds Stack Read & Infinite Loop in WAV Channel Reader
- **Location**: `readChannel` (`src/wav.zig:156-183`), `info` (`src/wav.zig:114-149`)
- **Severity**: High
- **Category**: Out-of-bounds buffer read / Infinite loop / Integer overflow on untrusted file input
- **Details**:
  1. **Unchecked `channel` index (OOB stack read)**:
     In `src/wav.zig:162-179`:
     ```zig
     const block: usize = @as(usize, i.channels) * 2;
     var buf: [64 * 1024]u8 = undefined;
     const per = buf.len / block;
     ...
     const s: i16 = @bitCast(buf[j * block + @as(usize, channel) * 2 ..][0..2].*);
     ```
     `readChannel` never validates `channel < i.channels`. If called with `channel >= i.channels` (e.g. `channel = 1` on a 1-channel file), `j * block + channel * 2` reads past the frame and, on the last frame in `buf`, reads out-of-bounds past the 64 KiB stack buffer `buf`.
  2. **Zero `per` causes infinite loop when `i.channels > 32768`**:
     `i.channels` is a raw `u16` parsed from the WAV `"fmt "` chunk (`src/wav.zig:131`). If a crafted or corrupted WAV header specifies `channels >= 32769`, `block = i.channels * 2 >= 65538 > buf.len (65536)`, so `per = buf.len / block == 0`. Inside `while (done < n)`, `const k = @min(per, n - done)` evaluates to `0`, `readSliceAll(buf[0..0])` is a no-op, and the thread spins forever.
  3. **`u32` integer overflow in WAV chunk cursor**:
     In `src/wav.zig:145`:
     ```zig
     const len = std.mem.readInt(u32, hdr[4..8], .little);
     ...
     at += 8 + len + (len & 1);
     ```
     Because `len` is `u32` and `8` is `comptime_int`, `8 + len + (len & 1)` is evaluated in `u32` before widening to `u64` (`at`). Any chunk header with `len >= 0xFFFF_FFF7` overflows `u32` (triggering a panic in safe builds or wrapping around into an infinite loop in `ReleaseFast`).
- **Fix**:
  - In `wav.info` (`src/wav.zig:131-145`), reject unreasonable channel counts (e.g., `if (channels == 0 or channels > 32 or rate == 0) return error.NotWav;`) and widen `len` before arithmetic: `at += 8 + @as(u64, len) + (@as(u64, len) & 1);`.
  - In `readChannel` (`src/wav.zig:156`), check `if (channel >= i.channels or i.channels == 0) return error.NotWav;`.

---

### 1.2 Potential `usize` Overflow in WAV Decoder Chunk Skip
- **Location**: `decodeWav` (`src/models.zig:714-728`)
- **Severity**: Low
- **Category**: Integer overflow / bounds check
- **Details**:
  ```zig
  const size = std.mem.readInt(u32, data[pos + 4 ..][0..4], .little);
  const body_start = pos + 8;
  const body_end = @min(data.len, body_start + size);
  ...
  pos = body_end + (size & 1);
  ```
  On 32-bit targets (or if `body_start + @as(usize, size)` overflows `usize`), `body_start + size` can overflow.
- **Fix**: Use saturating addition `body_start +| @as(usize, size)` and `body_end +| (@as(usize, size) & 1)`.

---

## 2. Confirmed Memory & Resource Leaks (Zig Backend)

### 2.1 Heap Memory Leak on Every LLM Load in `planRemembered`
- **Location**: `planRemembered` (`src/llm_helper.zig:780-793`)
- **Severity**: High
- **Category**: Heap memory leak (`std.json.parseFromSliceLeaky` on `gpa`)
- **Details**:
  ```zig
  fn planRemembered(key: PlanKey) ?Plan {
      const path = plans_path orelse return null;
      const data = std.Io.Dir.cwd().readFileAlloc(plan_io, path, plan_gpa, .limited(64 * 1024)) catch return null;
      defer plan_gpa.free(data);
      const parsed = std.json.parseFromSliceLeaky(PlanFile, plan_gpa, data, .{ .ignore_unknown_fields = true }) catch return null;
      ...
  ```
  Unlike `planRemember` (`src/llm_helper.zig:800-802`) and `planForget` (`src/llm_helper.zig:825-827`), which create a `std.heap.ArenaAllocator` around `plan_gpa`, `planRemembered` passes `plan_gpa` (the process-wide allocator) directly to `std.json.parseFromSliceLeaky`. Every call permanently leaks the parsed `[]PlanEntry` slice and all unescaped JSON strings.
- **Fix**: Wrap `plan_gpa` in `var arena_state = std.heap.ArenaAllocator.init(plan_gpa); defer arena_state.deinit();` or use `std.json.parseFromSlice` with `defer parsed.deinit()`.

---

### 2.2 Leaked `ggml_threadpool` (Memory + OS Threads) in `ChatModel`
- **Location**: `ChatModel.load` (`src/llm_helper.zig:465-467`) and `ChatModel.deinit` (`src/llm_helper.zig:525-529`)
- **Severity**: High
- **Category**: Native C memory & OS thread pool leak
- **Details**:
  In `ChatModel.load` (`src/llm_helper.zig:465-467`):
  ```zig
  var tpp = c.ggml_threadpool_params_default(threads);
  if (c.ggml_threadpool_new(&tpp)) |tp| c.llama_attach_threadpool(ctx, tp, tp);
  ```
  And in `ChatModel.deinit` (`src/llm_helper.zig:525-529`):
  ```zig
  fn deinit(self: *ChatModel) void {
      if (self.mtmd) |m| c.mtmd_free(m);
      c.llama_free(self.ctx);
      c.llama_model_free(self.model);
  }
  ```
  In `llama.cpp`, `llama_attach_threadpool` only stores a non-owning pointer on `llama_context`; `llama_free(self.ctx)` does **not** free the attached `ggml_threadpool` (compare with `oriel`'s `Loaded.deinit`, which stores `threadpool: c.ggml_threadpool_t` and calls `c.ggml_threadpool_free(self.threadpool)` after `c.llama_free(self.ctx)`).
  Additionally, if `mtmd_init_from_file` fails after `ggml_threadpool_new` (or when `ChatModel.deinit` is called), the `ggml_threadpool` struct and its worker threads are leaked.
- **Fix**: Store `threadpool: ?*c.struct_ggml_threadpool` in `ChatModel`, add `errdefer if (tp) |p| c.ggml_threadpool_free(p);` during `ChatModel.load` (after `errdefer c.llama_free(ctx)`), and call `if (self.threadpool) |tp| c.ggml_threadpool_free(tp);` after `c.llama_free(self.ctx)` in `ChatModel.deinit`.

---

### 2.3 Partial Allocation Leaks & Orphaned Queue Items in `meetings.enqueueJob`
- **Location**: `enqueueJob` (`src/meetings.zig:288-308`)
- **Severity**: Medium
- **Category**: Memory leak on error path
- **Details**:
  ```zig
  const job: Job = .{
      .root = gpa.dupe(u8, root) catch return,
      .id = gpa.dupe(u8, id) catch return,
      .step = step,
      .prompt = gpa.dupe(u8, prompt) catch return,
      .note = gpa.dupe(u8, note) catch return,
  };
  queue.append(gpa, job) catch return;
  if (!worker_running) {
      const t = std.Thread.spawn(.{}, workerMain, .{}) catch return;
      t.detach();
      worker_running = true;
  }
  ```
  1. If any `gpa.dupe` after `.root` fails, or if `queue.append` fails, all previously duplicated slices in `job` are leaked because there are no `errdefer`s.
  2. If `std.Thread.spawn` fails when `worker_running == false`, `job` is left in `queue` with no worker running (and its state remains stuck in busy until another job is enqueued).
- **Fix**: Dupe each field with `errdefer gpa.free(...)` before `queue.append`, and if `Thread.spawn` fails, pop `job` from `queue` and free its fields.

---

### 2.4 Unfreed `Engine` Fields & Duplicate CLI Arguments in `llm_helper.zig`
- **Location**: `main` (`src/llm_helper.zig:183-270`), `Engine.deinit` (`src/llm_helper.zig:938-944`), `controlTexts` (`src/llm_helper.zig:950-962`), `feedTokens` (`src/llm_helper.zig:1227`)
- **Severity**: Low
- **Category**: Memory leak
- **Details**:
  1. `Engine` (`src/llm_helper.zig:868-883`) allocates `specials.texts` (`gpa.dupe([]const u8, list.items)` in `controlTexts` at line 958) and grows `self.cached` (`self.cached.appendSlice(self.gpa, tokens)` in `feedTokens` at line 1227), neither of which is freed in `Engine.deinit` (`src/llm_helper.zig:938-944`).
  2. In `main` (`src/llm_helper.zig:183-224`), `opts.model`, `plans_path`, `opts.mmproj`, and `opts.embed_model` are allocated with `gpa.dupeZ` without freeing a prior allocation if a flag is passed twice, and without `defer` cleanup when `main` exits.

---

### 2.5 Unfreed `found` Allocation in `captions.defaultSinkMonitor` if Multiple Monitors Match
- **Location**: `defaultSinkMonitor` (`src/captions.zig:368-375`)
- **Severity**: Low
- **Category**: Heap memory leak
- **Details**:
  ```zig
  var found: ?[:0]u8 = null;
  for (sources) |src| {
      if (src.is_monitor and std.mem.eql(u8, src.name, wanted)) {
          found = try gpa.dupeZ(u8, src.name);
      }
  }
  ```
  There is no `break` after `found = try gpa.dupeZ(...)`. If the audio backend lists two entries with the same name, the first allocation is overwritten and leaked.
- **Fix**: Add `break;` immediately after `found = try gpa.dupeZ(u8, src.name);`.

---

### 2.6 Leaked `bind` and `config` Strings on `stt_server` Startup Error
- **Location**: `maybeStart` (`src/stt_server.zig:67-90`) and `serve` (`src/stt_server.zig:120-136`)
- **Severity**: Low
- **Category**: Heap memory leak on error path
- **Details**:
  In `maybeStart` (`src/stt_server.zig:77-88`), `bind`, `config.model_override`, and `config.language` are allocated with `gpa.dupe`.
  - If `parseBind(bind)` fails (line 80) or `std.Thread.spawn` fails (line 85), `bind`, `config.model_override`, and `config.language` are never freed.
  - Inside `serve` (`src/stt_server.zig:120-136`), `bind` is never freed at all, and if `models.ensure` or `address.listen` fails, `config.model_override` and `config.language` are also leaked.

---

## 3. Concurrency, Lifetime & Frontend Resource Issues

### 3.1 `updates.notify` Stores Unowned `body: []const u8` Across Detached Thread
- **Location**: `notify` (`src/updates.zig:287-300`)
- **Severity**: Low
- **Category**: Latent use-after-free hazard
- **Details**:
  ```zig
  fn notify(body: []const u8) void {
      const Ctx = struct {
          body: []const u8,
          fn run(self: *@This()) void {
              defer main.gpa.destroy(self);
              oriel.notification.show(main.io, .{ .title = "GhostPen", .body = self.body }) catch {};
          }
      };
  ```
  Currently both callers of `notify` pass string literals, so it does not crash today. However, `body` is typed as `[]const u8` and used asynchronously on a detached thread without copying it into `Ctx` (unlike `meetings.notifyDone` in `src/meetings.zig:898-923`, which safely copies `title` and `body` into fixed buffers inside `Ctx`). Any future caller passing a formatted or arena-allocated string to `updates.notify` would cause a use-after-free.
- **Fix**: Either copy `body` into a fixed buffer inside `Ctx` (like `meetings.notifyDone`) or `gpa.dupe` and `defer gpa.free` it inside `Ctx.run`.

---

### 3.2 Missing Dependency Array in `Meetings.tsx` Rebinds `keydown` Listener at 60 FPS
- **Location**: `Meetings` (`frontend/src/Meetings.tsx:483-509`)
- **Severity**: Low
- **Category**: Frontend listener churn / allocation pressure
- **Details**:
  - Lines 471–480 run a `requestAnimationFrame` loop while audio is playing that calls `setTime(audioRef.current.currentTime)` on every frame (60 Hz), triggering a full re-render of `Meetings` 60 times per second.
  - Immediately below, the `keydown` `useEffect` at lines 483–509 omits a dependency array, causing `window.removeEventListener("keydown", onKey)` and `window.addEventListener("keydown", onKey)` (plus closure allocation) to run on every single animation frame during playback.

---

### 3.3 Continuous 60 FPS `requestAnimationFrame` Loop When `Dictation` Window Is Idle/Hidden
- **Location**: `Dictation` (`frontend/src/Dictation.tsx:138-168`)
- **Severity**: Low
- **Category**: Background CPU / DOM style-mutation churn
- **Details**:
  The `Dictation` overlay window is created at startup and kept hidden when not in use. Its `useEffect` at line 138 starts an unconditional `requestAnimationFrame` loop on mount that never stops when `phase` is `"idle"`, `"done"`, or `"error"`, mutating `el.style.height` across all 40 waveform bars 60 times per second for the lifetime of the application.
- **Fix**: Only run the `requestAnimationFrame` loop while `phase === "listening"` (or until `levelNow.current` decays below `0.001`).

---

## Summary Table

| # | Severity | File | Symbol | Issue |
|---|----------|------|--------|-------|
| 1.1 | **High** | `src/wav.zig` | `info`, `readChannel` | OOB stack read if `channel >= i.channels`; infinite loop if `channels > 32768`; `u32` chunk size overflow |
| 1.2 | **Low** | `src/models.zig` | `decodeWav` | Potential `usize` overflow on malformed WAV chunk size |
| 2.1 | **High** | `src/llm_helper.zig` | `planRemembered` | `parseFromSliceLeaky` called directly on `plan_gpa` without an arena |
| 2.2 | **High** | `src/llm_helper.zig` | `ChatModel.load`, `ChatModel.deinit` | `ggml_threadpool_new` never freed via `ggml_threadpool_free` |
| 2.3 | **Medium** | `src/meetings.zig` | `enqueueJob` | Partial `gpa.dupe` leak on OOM; orphaned job if thread spawn fails |
| 2.4 | **Low** | `src/llm_helper.zig` | `Engine.deinit`, `main` | `specials.texts`, `cached`, and CLI `dupeZ` strings not freed |
| 2.5 | **Low** | `src/captions.zig` | `defaultSinkMonitor` | Missing `break` leaks previous `found` if duplicate monitor entries exist |
| 2.6 | **Low** | `src/stt_server.zig` | `maybeStart`, `serve` | `bind` and `config` strings leaked on startup failure |
| 3.1 | **Low** | `src/updates.zig` | `notify` | Detached thread holds unowned `body: []const u8` slice |
| 3.2 | **Low** | `frontend/src/Meetings.tsx` | `Meetings` | Missing `useEffect` dependency array rebinds `keydown` listener at 60 Hz |
| 3.3 | **Low** | `frontend/src/Dictation.tsx` | `Dictation` | Unconditional 60 FPS `requestAnimationFrame` loop runs while idle/hidden |
