//! Speakers by voice (MEETINGS.md phase 3): known voices the user named,
//! kept in the app data as `voices.json`, and the live tracker that labels
//! caption chunks as they come. Pure data and math; the embeddings come
//! from `oriel.speakers` (meetings.zig, captions.zig).

const std = @import("std");

pub const file_name = "voices.json";

/// A named voice: the centroid of its embeddings (L2-normalized), in the
/// embedding space `family` (embeddings of other models never match).
pub const Voice = struct {
    name: []const u8,
    family: []const u8,
    embedding: []const f32,
    /// How many meetings fed the centroid (a new one moves it less).
    meetings: u32 = 1,
};

pub const File = struct {
    version: u32 = 1,
    voices: []const Voice = &.{},
};

/// A centroid this similar to a known voice is that person.
pub const known_threshold: f32 = 0.55;
/// Live labels: a chunk this similar to a speaker so far is them.
pub const live_threshold: f32 = 0.5;

pub fn cosine(a: []const f32, b: []const f32) f32 {
    if (a.len != b.len or a.len == 0) return 0;
    var dot: f32 = 0;
    var na: f32 = 0;
    var nb: f32 = 0;
    for (a, b) |x, y| {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if (na == 0 or nb == 0) return 0;
    return dot / (@sqrt(na) * @sqrt(nb));
}

pub fn normalize(v: []f32) void {
    var n: f32 = 0;
    for (v) |x| n += x * x;
    if (n == 0) return;
    const inv = 1 / @sqrt(n);
    for (v) |*x| x.* *= inv;
}

/// The best known voice of `family` for `centroid`, or null under the threshold.
pub fn bestMatch(voices: []const Voice, family: []const u8, centroid: []const f32) ?usize {
    var best: ?usize = null;
    var best_sim: f32 = known_threshold;
    for (voices, 0..) |v, i| {
        if (!std.mem.eql(u8, v.family, family) or v.embedding.len != centroid.len) continue;
        const sim = cosine(v.embedding, centroid);
        if (sim >= best_sim) {
            best_sim = sim;
            best = i;
        }
    }
    return best;
}

pub fn load(io: std.Io, arena: std.mem.Allocator, path: []const u8) !File {
    const body = std.Io.Dir.cwd().readFileAlloc(io, path, arena, .limited(16 * 1024 * 1024)) catch |err| switch (err) {
        error.FileNotFound => return .{},
        else => return err,
    };
    return std.json.parseFromSliceLeaky(File, arena, body, .{ .ignore_unknown_fields = true, .allocate = .alloc_always });
}

pub fn save(io: std.Io, arena: std.mem.Allocator, path: []const u8, f: File) !void {
    const body = try std.json.Stringify.valueAlloc(arena, f, .{});
    const dir = std.fs.path.dirname(path) orelse return error.BadPath;
    try std.Io.Dir.cwd().createDirPath(io, dir);
    const tmp = try std.fmt.allocPrint(arena, "{s}.tmp", .{path});
    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = tmp, .data = body });
    try std.Io.Dir.cwd().rename(tmp, std.Io.Dir.cwd(), path, io);
}

/// Remember `embedding` as `name`: a voice of that name (and family) moves
/// toward it, weighted by the meetings it already came from; else a new
/// voice. Returns the new list (in `arena`).
pub fn remember(arena: std.mem.Allocator, voices: []const Voice, name: []const u8, family: []const u8, embedding: []const f32) ![]const Voice {
    var out: std.ArrayList(Voice) = .empty;
    var merged = false;
    for (voices) |v| {
        if (!merged and std.ascii.eqlIgnoreCase(v.name, name) and std.mem.eql(u8, v.family, family) and v.embedding.len == embedding.len) {
            const e = try arena.alloc(f32, embedding.len);
            const w: f32 = @floatFromInt(@min(v.meetings, 20));
            for (e, v.embedding, embedding) |*o, old, new| o.* = (old * w + new) / (w + 1);
            normalize(e);
            try out.append(arena, .{ .name = try arena.dupe(u8, name), .family = v.family, .embedding = e, .meetings = v.meetings + 1 });
            merged = true;
        } else try out.append(arena, v);
    }
    if (!merged) {
        const e = try arena.dupe(f32, embedding);
        normalize(e);
        try out.append(arena, .{ .name = try arena.dupe(u8, name), .family = try arena.dupe(u8, family), .embedding = e });
    }
    return out.items;
}

pub fn forget(arena: std.mem.Allocator, voices: []const Voice, name: []const u8) ![]const Voice {
    var out: std.ArrayList(Voice) = .empty;
    for (voices) |v| if (!std.ascii.eqlIgnoreCase(v.name, name)) try out.append(arena, v);
    return out.items;
}

/// Live labels: caption chunks assigned to the speakers heard so far
/// (nearest centroid above `live_threshold`, else a new speaker), with
/// running-mean centroids. Less accurate than the meeting's diarization
/// on save, which redoes it over the whole recording.
pub const Tracker = struct {
    gpa: std.mem.Allocator,
    dim: usize = 0,
    /// Centroids, `dim` floats each, back to back.
    centroids: std.ArrayList(f32) = .empty,
    counts: std.ArrayList(u32) = .empty,
    /// The known voice each speaker matched (index into the caller's list), if any.
    known: std.ArrayList(?usize) = .empty,

    pub const max_speakers = 12;

    pub fn deinit(t: *Tracker) void {
        t.centroids.deinit(t.gpa);
        t.counts.deinit(t.gpa);
        t.known.deinit(t.gpa);
    }

    pub fn speakers(t: *const Tracker) usize {
        return t.counts.items.len;
    }

    fn centroid(t: *const Tracker, i: usize) []const f32 {
        return t.centroids.items[i * t.dim ..][0..t.dim];
    }

    /// The speaker (0-based) for an L2-normalized embedding.
    pub fn assign(t: *Tracker, e: []const f32, voices: []const Voice, family: []const u8) !usize {
        if (t.dim == 0) t.dim = e.len;
        if (e.len != t.dim) return error.DimensionMismatch;
        var best: ?usize = null;
        var best_sim: f32 = live_threshold;
        for (0..t.speakers()) |i| {
            const sim = cosine(t.centroid(i), e);
            if (sim >= best_sim) {
                best_sim = sim;
                best = i;
            }
        }
        // Past the cap: the nearest one, whatever the similarity.
        if (best == null and t.speakers() >= max_speakers) {
            var near: usize = 0;
            var near_sim: f32 = -2;
            for (0..t.speakers()) |i| {
                const sim = cosine(t.centroid(i), e);
                if (sim > near_sim) {
                    near_sim = sim;
                    near = i;
                }
            }
            best = near;
        }
        if (best) |i| {
            const c = t.centroids.items[i * t.dim ..][0..t.dim];
            const n: f32 = @floatFromInt(@min(t.counts.items[i], 50));
            for (c, e) |*x, y| x.* = (x.* * n + y) / (n + 1);
            normalize(c);
            t.counts.items[i] += 1;
            if (t.known.items[i] == null) t.known.items[i] = bestMatch(voices, family, c);
            return i;
        }
        try t.centroids.appendSlice(t.gpa, e);
        normalize(t.centroids.items[t.centroids.items.len - t.dim ..]);
        try t.counts.append(t.gpa, 1);
        try t.known.append(t.gpa, bestMatch(voices, family, e));
        return t.speakers() - 1;
    }
};

// ---- tests -------------------------------------------------------------------------------

fn unit(comptime n: usize, hot: usize, noise: f32, seed: u64) [n]f32 {
    var r: std.Random.DefaultPrng = .init(seed);
    var v: [n]f32 = undefined;
    for (&v, 0..) |*x, i| x.* = (if (i == hot) @as(f32, 1) else 0) + (r.random().float(f32) - 0.5) * noise;
    normalize(&v);
    return v;
}

test "Tracker: two voices stay apart, a known one is named" {
    var t: Tracker = .{ .gpa = std.testing.allocator };
    defer t.deinit();
    const ana = unit(16, 3, 0.3, 9);
    const voices = [_]Voice{.{ .name = "Ana", .family = "f", .embedding = &ana }};
    var seed: u64 = 1;
    for (0..10) |k| {
        const hot: usize = if (k % 2 == 0) 3 else 7;
        const e = unit(16, hot, 0.3, seed);
        seed += 1;
        _ = try t.assign(&e, &voices, "f");
    }
    try std.testing.expectEqual(@as(usize, 2), t.speakers());
    try std.testing.expectEqual(@as(?usize, 0), t.known.items[0]);
    try std.testing.expectEqual(@as(?usize, null), t.known.items[1]);
    // Another family never matches.
    var u: Tracker = .{ .gpa = std.testing.allocator };
    defer u.deinit();
    _ = try u.assign(&ana, &voices, "other");
    try std.testing.expectEqual(@as(?usize, null), u.known.items[0]);
}

test "remember moves a voice, forget drops it, files round-trip" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e1 = unit(8, 0, 0, 1);
    const e2 = unit(8, 1, 0, 1);
    var vs = try remember(a, &.{}, "Ana", "f", &e1);
    vs = try remember(a, vs, "ana", "f", &e2);
    try std.testing.expectEqual(@as(usize, 1), vs.len);
    try std.testing.expectEqual(@as(u32, 2), vs[0].meetings);
    // One meeting each: halfway between.
    try std.testing.expectApproxEqAbs(cosine(vs[0].embedding, &e1), cosine(vs[0].embedding, &e2), 1e-5);
    vs = try remember(a, vs, "Bob", "f", &e2);
    try std.testing.expectEqual(@as(?usize, 1), bestMatch(vs, "f", &e2));

    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    const p = try std.fs.path.join(a, &.{ buf[0..try tmp.dir.realPath(io, &buf)], "x", file_name });
    try std.testing.expectEqual(@as(usize, 0), (try load(io, a, p)).voices.len);
    try save(io, a, p, .{ .voices = vs });
    const back = try load(io, a, p);
    try std.testing.expectEqual(@as(usize, 2), back.voices.len);
    try std.testing.expectEqual(@as(usize, 1), (try forget(a, back.voices, "ANA")).len);
}
