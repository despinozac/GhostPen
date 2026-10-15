import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { listen } from "./events";
import {
  copyText,
  meetingsDelete,
  meetingsExport,
  meetingsGet,
  meetingsList,
  meetingsOpenFolder,
  meetingsReleaseAudio,
  meetingsReprocess,
  meetingsUpdate,
  meetingsVoices,
  meetingsRememberVoice,
  meetingsForgetVoice,
  type KnownVoice,
  type Meeting,
  type MeetingDetail,
  type MeetingEdit,
  type MeetingExport,
  type MeetingProgress,
  type MeetingSegment,
  type MeetingSpeaker,
  type MeetingSummary,
} from "./api";

// The Meetings window (MEETINGS.md): saved meetings, a player that follows
// the transcript, speakers to rename/merge/reassign, lines to edit, the
// clean (proofread) text, export and management. The Zig side owns the
// files (src/meetings.zig); every edit goes through meetings_update.

const STATE_LABEL: Record<string, string> = {
  recording: "Recording",
  saving: "Saving",
  transcribing: "Transcribing",
  diarizing: "Finding speakers",
  proofreading: "Proofreading",
  ready: "Ready",
  error: "Needs attention",
};

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const SPEAKER_COLORS = 8;

function clock(seconds: number): string {
  const t = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(t / 3600);
  const mm = String(Math.floor(t / 60) % 60).padStart(2, "0");
  const ss = String(t % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function duration(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const busyState = (s: string) => s !== "ready" && s !== "error";

/** The speaker's colour slot, stable by their position in the list. */
function colorOf(speakers: MeetingSpeaker[], id: string): number {
  const i = speakers.findIndex((s) => s.id === id);
  return id === "me" ? 0 : ((i < 0 ? 0 : i) % (SPEAKER_COLORS - 1)) + 1;
}

/** The index of the line being said at `t` (the last one started, until
 * shortly after it ends), or -1 in the silence between lines. */
function lineAt(lines: MeetingSegment[], t: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  // Past its end (the line's times are its words'): nothing is being said.
  if (found >= 0 && t > lines[found].end + 0.4) return -1;
  return found;
}

/** Lines sorted by start (the two tracks interleave). */
function byStart(lines: MeetingSegment[]): MeetingSegment[] {
  return [...lines].sort((a, b) => a.start - b.start);
}

function nextSpeakerId(speakers: MeetingSpeaker[]): string {
  let n = 1;
  while (speakers.some((s) => s.id === `s${n}`)) n++;
  return `s${n}`;
}

/** Text with the find matches marked. */
function Highlighted({ text, find }: { text: string; find: string }) {
  if (!find) return <>{text}</>;
  const parts: ReactNode[] = [];
  const lower = text.toLowerCase();
  const q = find.toLowerCase();
  let at = 0;
  let k = 0;
  for (;;) {
    const i = lower.indexOf(q, at);
    if (i < 0) break;
    if (i > at) parts.push(text.slice(at, i));
    parts.push(<mark key={k++}>{text.slice(i, i + q.length)}</mark>);
    at = i + q.length;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

/** The line's words with their times, unless the text was edited since. */
function timedWords(l: MeetingSegment) {
  if (!l.words?.length) return null;
  const squash = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  return squash(l.words.map((w) => w.text).join("")) === squash(l.text) ? l.words : null;
}

/** A playing line's words by their times: said, being said, still to come. */
function TimedWords({ words, time }: { words: { start: number; end: number; text: string }[]; time: number }) {
  let current = -1;
  for (let i = 0; i < words.length && words[i].start <= time; i++) current = i;
  return (
    <>
      {words.map((w, i) => (
        <Fragment key={i}>
          {i > 0 && " "}
          <span className={i === current && time <= w.end + 0.3 ? "mt-word now" : i <= current ? "mt-word said" : "mt-word"}>{w.text}</span>
        </Fragment>
      ))}
    </>
  );
}

/** A playing line's words, the one being spoken (estimated from the time) marked:
 * lines without word times (edited, the clean text, older meetings). */
function SpokenWords({ text, fraction }: { text: string; fraction: number }) {
  const words = text.split(/(\s+)/);
  const real = words.filter((w) => w.trim()).length;
  const current = Math.min(real - 1, Math.floor(fraction * real));
  let n = -1;
  return (
    <>
      {words.map((w, i) => {
        if (!w.trim()) return <Fragment key={i}>{w}</Fragment>;
        n++;
        return (
          <span key={i} className={n === current ? "mt-word now" : n < current ? "mt-word said" : "mt-word"}>
            {w}
          </span>
        );
      })}
    </>
  );
}

export default function Meetings() {
  const [list, setList] = useState<MeetingSummary[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [progress, setProgress] = useState<Record<string, MeetingProgress>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<"transcript" | "final">("transcript");
  const [find, setFind] = useState("");
  const [loadingList, setLoadingList] = useState(true);

  // The player.
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [follow, setFollow] = useState(true);
  const [audioError, setAudioError] = useState<string | null>(null);

  // Editing.
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [editingLine, setEditingLine] = useState<number | null>(null);
  const [lineDraft, setLineDraft] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [speakerMenu, setSpeakerMenu] = useState<string | null>(null);
  const [lineMenu, setLineMenu] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [menuOpen, setMenuOpen] = useState<"export" | "rerun" | null>(null);
  const [voicesOpen, setVoicesOpen] = useState(false);
  // The list's right-click menu: which meeting, where, and whether Delete was clicked once.
  const [ctxMenu, setCtxMenu] = useState<{ id: string; x: number; y: number; confirm: boolean } | null>(null);
  const [known, setKnown] = useState<KnownVoice[]>([]);

  const linesRef = useRef<HTMLDivElement>(null);
  const userScrolledAt = useRef(0);

  const meeting = detail?.meeting ?? null;
  const editable = !!meeting && !detail?.busy && !busyState(meeting.state);

  // ---- data ----

  const refreshList = useCallback(async (q = query) => {
    try {
      setList(await meetingsList(q));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingList(false);
    }
  }, [query]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const d = await meetingsGet(id);
      setDetail(d);
      setError(null);
    } catch (e) {
      setDetail(null);
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => refreshList(query), 200);
    return () => window.clearTimeout(t);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  // The first meeting opens by itself.
  useEffect(() => {
    if (!selected && list.length > 0) setSelected(list[0].id);
  }, [list, selected]);

  useEffect(() => {
    setEditingLine(null);
    setRenaming(null);
    setConfirmDelete(false);
    setMenuOpen(null);
    setTime(0);
    setPlaying(false);
    setAudioError(null);
    if (selected) loadDetail(selected);
    else setDetail(null);
  }, [selected, loadDetail]);

  // Pipeline progress: the list's badges, and the open meeting reloaded when a step ends.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    const un = listen<MeetingProgress>("ghostpen://meeting", (e) => {
      const p = e.payload;
      setProgress((prev) => ({ ...prev, [p.id]: p }));
      setList((prev) => {
        if (!prev.some((m) => m.id === p.id)) {
          refreshList();
          return prev;
        }
        return prev.map((m) => (m.id === p.id ? { ...m, state: p.state } : m));
      });
      if (p.id === selectedRef.current && (p.state === "ready" || p.state === "error" || p.progress === 0)) {
        loadDetail(p.id);
      }
      if (p.state === "ready" || p.state === "error") refreshList();
    });
    return () => {
      un.then((f) => f());
    };
  }, [loadDetail, refreshList]);

  // Hidden window: stop playing and serving the audio; shown again: reload.
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) {
        audioRef.current?.pause();
        meetingsReleaseAudio().catch(() => {});
      } else {
        refreshList();
        if (selectedRef.current) loadDetail(selectedRef.current);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [loadDetail, refreshList]);

  const refreshVoices = () => meetingsVoices().then(setKnown).catch(() => {});
  useEffect(() => {
    refreshVoices();
  }, []);

  const rememberVoice = async (sp: MeetingSpeaker) => {
    if (!detail) return;
    setSpeakerMenu(null);
    try {
      const m = await meetingsRememberVoice(detail.id, sp.id);
      setDetail({ ...detail, meeting: m });
      refreshVoices();
      flash(`GhostPen will recognise ${sp.name} in the next meetings`);
    } catch (e) {
      setError(String(e));
    }
  };

  const forgetVoice = async (name: string) => {
    try {
      await meetingsForgetVoice(name);
      refreshVoices();
    } catch (e) {
      setError(String(e));
    }
  };

  const flash = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice((n) => (n === msg ? null : n)), 2500);
  };

  const save = async (edit: MeetingEdit) => {
    if (!detail) return;
    try {
      const m = await meetingsUpdate(detail.id, edit);
      setDetail({ ...detail, meeting: m });
      if (edit.title !== undefined) refreshList();
    } catch (e) {
      setError(String(e));
    }
  };

  // ---- lines ----

  const lines = useMemo<MeetingSegment[]>(() => {
    if (!meeting) return [];
    return byStart(tab === "final" ? meeting.final : meeting.segments);
  }, [meeting, tab]);

  const current = useMemo(() => lineAt(lines, time), [lines, time]);

  const matches = useMemo(() => {
    if (!find.trim()) return [];
    const q = find.trim().toLowerCase();
    return lines.flatMap((l, i) => (l.text.toLowerCase().includes(q) ? [i] : []));
  }, [lines, find]);

  const talk = useMemo(() => {
    const out: Record<string, number> = {};
    if (!meeting) return out;
    let total = 0;
    for (const s of meeting.segments) {
      const d = Math.max(0, s.end - s.start);
      out[s.speaker] = (out[s.speaker] ?? 0) + d;
      total += d;
    }
    for (const k of Object.keys(out)) out[k] = total > 0 ? out[k] / total : 0;
    return out;
  }, [meeting]);

  // Follow the playing line, unless the user scrolled in the last few seconds.
  useEffect(() => {
    if (!follow || !playing || current < 0) return;
    if (Date.now() - userScrolledAt.current < 4000) return;
    const el = linesRef.current?.querySelector<HTMLElement>(`[data-line="${current}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [current, follow, playing]);

  const scrollToLine = (i: number) => {
    linesRef.current?.querySelector<HTMLElement>(`[data-line="${i}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  // ---- the player ----

  // Stereo recordings (the others left, you right) play as they are: a Web
  // Audio mono mix played silence in WebKitGTK (the media server's audio
  // came out of MediaElementSource as nothing).
  const play = async () => {
    const el = audioRef.current;
    if (!el) return;
    try {
      await el.play();
    } catch (e) {
      setAudioError(`Can't play the recording (${e}).`);
    }
  };

  const toggle = () => (playing ? audioRef.current?.pause() : play());

  const seek = (t: number, andPlay = false) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(t, el.duration || t));
    setTime(el.currentTime);
    userScrolledAt.current = 0;
    if (andPlay && el.paused) play();
  };

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed, detail?.audio]);

  // timeupdate comes about 4 times a second: too coarse for a word at a
  // time. While playing, read the position every frame.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      if (audioRef.current) setTime(audioRef.current.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  // Keyboard: Space play/pause, ←/→ 5 s, J/L 10 s, Ctrl+F find.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        document.getElementById("mt-find")?.focus();
        return;
      }
      if (typing || !audioRef.current) return;
      const el = audioRef.current;
      if (e.key === " ") {
        e.preventDefault();
        toggle();
      } else if (e.key === "ArrowLeft") seek(el.currentTime - 5);
      else if (e.key === "ArrowRight") seek(el.currentTime + 5);
      else if (e.key.toLowerCase() === "j") seek(el.currentTime - 10);
      else if (e.key.toLowerCase() === "l") seek(el.currentTime + 10);
      else if (e.key === "Escape") {
        setSpeakerMenu(null);
        setLineMenu(null);
        setMenuOpen(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---- speakers ----

  const renameSpeaker = (id: string, name: string) => {
    if (!meeting) return;
    const n = name.trim();
    setRenaming(null);
    if (!n || n === meeting.speakers.find((s) => s.id === id)?.name) return;
    save({ speakers: meeting.speakers.map((s) => (s.id === id ? { ...s, name: n } : s)) });
  };

  const mergeSpeaker = (from: string, into: string) => {
    if (!meeting || from === into) return;
    setSpeakerMenu(null);
    const name = (id: string) => meeting.speakers.find((s) => s.id === id)?.name ?? id;
    save({
      speakers: meeting.speakers.filter((s) => s.id !== from),
      segments: meeting.segments.map((s) => (s.speaker === from ? { ...s, speaker: into } : s)),
      final: meeting.final.map((s) => (s.speaker === from ? { ...s, speaker: into } : s)),
    });
    flash(`${name(from)} merged into ${name(into)}`);
  };

  /** Give one line (of the open tab) to `speaker` ("" = a new speaker). */
  const reassign = (index: number, speaker: string) => {
    if (!meeting) return;
    setLineMenu(null);
    let speakers = meeting.speakers;
    let id = speaker;
    if (!id) {
      id = nextSpeakerId(speakers);
      speakers = [...speakers, { id, name: `Speaker ${speakers.filter((s) => s.id !== "me").length + 1}` }];
    }
    const line = lines[index];
    const swap = (arr: MeetingSegment[]) => arr.map((s) => (s === line ? { ...s, speaker: id } : s));
    save(tab === "final" ? { speakers, final: swap(meeting.final) } : { speakers, segments: swap(meeting.segments) });
  };

  const saveLine = (index: number) => {
    if (!meeting) return;
    const line = lines[index];
    const text = lineDraft.trim();
    setEditingLine(null);
    if (!text || text === line.text) return;
    const edit = (arr: MeetingSegment[]) => arr.map((s) => (s === line ? { ...s, text } : s));
    save(tab === "final" ? { final: edit(meeting.final) } : { segments: edit(meeting.segments) });
  };

  // ---- actions ----

  const doExport = async (format: MeetingExport, label: string) => {
    if (!detail) return;
    setMenuOpen(null);
    try {
      await copyText(await meetingsExport(detail.id, format));
      flash(`${label} copied`);
    } catch (e) {
      setError(String(e));
    }
  };

  const rerun = async (step: "transcribe" | "speakers" | "proofread") => {
    if (!detail) return;
    setMenuOpen(null);
    try {
      await meetingsReprocess(detail.id, step);
      await loadDetail(detail.id);
    } catch (e) {
      setError(String(e));
    }
  };

  const removeId = async (id: string) => {
    try {
      if (id === detail?.id) audioRef.current?.pause();
      await meetingsDelete(id);
      if (id === selected) setSelected(null);
      setConfirmDelete(false);
      await refreshList();
    } catch (e) {
      setError(String(e));
    }
  };

  const remove = () => (detail ? removeId(detail.id) : Promise.resolve());

  // The list's menu actions.
  const ctxAction = async (action: "open" | "rename" | "copy" | "folder") => {
    if (!ctxMenu) return;
    const { id } = ctxMenu;
    setCtxMenu(null);
    try {
      if (action === "folder") await meetingsOpenFolder(id);
      else if (action === "copy") {
        await copyText(await meetingsExport(id, "text"));
        flash("Clean text copied");
      } else {
        setSelected(id);
        if (action === "rename") pendingRename.current = id;
      }
    } catch (e) {
      setError(String(e));
    }
  };
  const pendingRename = useRef<string | null>(null);
  // Rename from the list: once the meeting is open, its title turns into the field.
  useEffect(() => {
    if (detail && pendingRename.current === detail.id && editable) {
      pendingRename.current = null;
      setTitleDraft(detail.meeting.title);
      setEditingTitle(true);
    }
  }, [detail, editable]);

  // No WebKit menu (Back, Reload…) anywhere in the window; a click or Esc closes ours.
  useEffect(() => {
    const block = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea")) return; // keep copy/paste in fields
      e.preventDefault();
    };
    const close = (e: KeyboardEvent) => e.key === "Escape" && setCtxMenu(null);
    window.addEventListener("contextmenu", block);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("contextmenu", block);
      window.removeEventListener("keydown", close);
    };
  }, []);

  // ---- render ----

  const live = detail ? progress[detail.id] : undefined;
  const liveState = live && meeting && live.state !== meeting.state && busyState(live.state) ? live : undefined;
  const state = liveState?.state ?? meeting?.state;

  return (
    <div className="meetings" onClick={() => { setSpeakerMenu(null); setLineMenu(null); setMenuOpen(null); setCtxMenu(null); }}>
      <aside className="mt-side">
        <div className="mt-side-head">
          <h1>Meetings</h1>
          <button className="mt-icon-btn" title="Open the meetings folder" onClick={() => meetingsOpenFolder().catch((e) => setError(String(e)))}>
            📁
          </button>
        </div>
        <input
          className="mt-search"
          type="search"
          placeholder="Search titles, speakers, words…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="mt-list" role="listbox" aria-label="Saved meetings">
          {loadingList && <div className="mt-empty">Loading…</div>}
          {!loadingList && list.length === 0 && (
            <div className="mt-empty">
              {query ? "No meeting matches." : (
                <>
                  No meetings yet.
                  <br />
                  Turn on <b>🎙 Meeting</b> in the captions bar, then Start: when you stop, the meeting is saved here.
                </>
              )}
            </div>
          )}
          {list.map((m) => {
            const p = progress[m.id];
            const st = p && busyState(p.state) ? p.state : m.state;
            return (
              <button
                key={m.id}
                role="option"
                aria-selected={m.id === selected}
                className={`mt-item ${m.id === selected ? "active" : ""}`}
                onClick={() => setSelected(m.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setCtxMenu({ id: m.id, x: e.clientX, y: e.clientY, confirm: false });
                }}
              >
                <span className="mt-item-title">{m.title || "Meeting"}</span>
                <span className="mt-item-meta">
                  {m.startedLocal} · {duration(m.durationMs)}
                  {st !== "ready" && (
                    <span className={`mt-badge ${st}`}>
                      {STATE_LABEL[st] ?? st}
                      {p && busyState(p.state) && p.progress > 0 ? ` ${Math.round(p.progress * 100)}%` : ""}
                    </span>
                  )}
                </span>
                {m.preview && <span className="mt-item-preview">{m.preview}</span>}
              </button>
            );
          })}
        </div>
        <div className="mt-side-foot" onClick={(e) => e.stopPropagation()}>
          <button className="mt-voices-btn" onClick={() => setVoicesOpen(!voicesOpen)}>
            🗣 Known voices{known.length ? ` (${known.length})` : ""} {voicesOpen ? "▴" : "▾"}
          </button>
          {voicesOpen && (
            <div className="mt-voices">
              {known.length === 0 && (
                <div className="mt-voices-empty">
                  None yet. Rename a speaker, then pick <b>Remember this voice</b> in their menu: later meetings name them.
                </div>
              )}
              {known.map((v) => (
                <div key={`${v.family}/${v.name}`} className="mt-voice">
                  <span>{v.name}</span>
                  <span className="mt-voice-n">{v.meetings} meeting{v.meetings === 1 ? "" : "s"}</span>
                  <button title={`Forget ${v.name}'s voice`} onClick={() => forgetVoice(v.name)}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>

      {ctxMenu && (() => {
        const m = list.find((x) => x.id === ctxMenu.id);
        const busy = !m || busyState(progress[ctxMenu.id]?.state ?? m.state);
        return (
          <div
            className="mt-menu mt-ctx"
            style={{ left: Math.min(ctxMenu.x, window.innerWidth - 210), top: Math.min(ctxMenu.y, window.innerHeight - 200) }}
            onClick={(e) => e.stopPropagation()}
          >
            <button onClick={() => ctxAction("open")}>Open</button>
            <button disabled={busy} onClick={() => ctxAction("rename")}>Rename…</button>
            <button onClick={() => ctxAction("copy")}>Copy clean text</button>
            <button onClick={() => ctxAction("folder")}>Open folder</button>
            <div className="mt-menu-sep" />
            {ctxMenu.confirm ? (
              <button className="danger" onClick={() => { const id = ctxMenu.id; setCtxMenu(null); removeId(id); }}>
                Delete “{m?.title || "Meeting"}” for good
              </button>
            ) : (
              <button className="danger" disabled={busy} title={busy ? "Wait until it's saved" : undefined} onClick={() => setCtxMenu({ ...ctxMenu, confirm: true })}>
                Delete…
              </button>
            )}
          </div>
        );
      })()}

      <main className="mt-main">
        {error && (
          <div className="mt-error" onClick={() => setError(null)} title="Dismiss">
            ⚠ {error}
          </div>
        )}
        {notice && <div className="mt-notice">{notice}</div>}

        {!meeting && !error && <div className="mt-placeholder">{list.length ? "Pick a meeting." : ""}</div>}

        {meeting && detail && (
          <>
            <header className="mt-head">
              <div className="mt-head-text">
                {editingTitle ? (
                  <input
                    className="mt-title-input"
                    autoFocus
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onBlur={() => {
                      setEditingTitle(false);
                      if (titleDraft.trim() && titleDraft.trim() !== meeting.title) save({ title: titleDraft.trim() });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") {
                        setTitleDraft(meeting.title);
                        setEditingTitle(false);
                      }
                    }}
                  />
                ) : (
                  <h2
                    className={editable ? "mt-title editable" : "mt-title"}
                    title={editable ? "Rename" : undefined}
                    onClick={() => {
                      if (!editable) return;
                      setTitleDraft(meeting.title);
                      setEditingTitle(true);
                    }}
                  >
                    {meeting.title || "Meeting"}
                  </h2>
                )}
                <div className="mt-meta">
                  {meeting.startedLocal} · {duration(meeting.durationMs)}
                  {meeting.language && meeting.language !== "auto" ? ` · ${meeting.language}` : ""}
                  {meeting.model ? ` · whisper ${meeting.model}` : ""}
                </div>
              </div>
              <div className="mt-actions" onClick={(e) => e.stopPropagation()}>
                <div className="mt-dropdown">
                  <button className="mt-btn" disabled={!meeting.segments.length} onClick={() => setMenuOpen(menuOpen === "export" ? null : "export")}>
                    Copy ▾
                  </button>
                  {menuOpen === "export" && (
                    <div className="mt-menu">
                      <button onClick={() => doExport("text", "Clean text")}>Clean text</button>
                      <button onClick={() => doExport("final", "Markdown (clean)")}>Markdown, clean</button>
                      <button onClick={() => doExport("transcript", "Markdown transcript")}>Markdown, transcript with times</button>
                      <button onClick={() => doExport("srt", "Subtitles")}>Subtitles (SRT)</button>
                    </div>
                  )}
                </div>
                <div className="mt-dropdown">
                  <button className="mt-btn" disabled={!editable} onClick={() => setMenuOpen(menuOpen === "rerun" ? null : "rerun")}>
                    Redo ▾
                  </button>
                  {menuOpen === "rerun" && (
                    <div className="mt-menu">
                      <button onClick={() => rerun("proofread")}>Proofread again</button>
                      <button onClick={() => rerun("speakers")}>Find the speakers again</button>
                      <button onClick={() => rerun("transcribe")} title="Your edits to the lines are replaced">
                        Transcribe again (replaces edits)
                      </button>
                    </div>
                  )}
                </div>
                <button className="mt-btn" onClick={() => meetingsOpenFolder(detail.id).catch((e) => setError(String(e)))} title={detail.folder}>
                  Folder
                </button>
                {confirmDelete ? (
                  <>
                    <button className="mt-btn danger solid" onClick={remove}>Delete for good</button>
                    <button className="mt-btn" onClick={() => setConfirmDelete(false)}>Keep</button>
                  </>
                ) : (
                  <button className="mt-btn danger" disabled={detail.busy} onClick={() => setConfirmDelete(true)}>
                    Delete
                  </button>
                )}
              </div>
            </header>

            {state && busyState(state) && (
              <div className="mt-progress">
                <span>
                  {STATE_LABEL[state] ?? state}…
                  {state === "recording" ? " Stop the captions to save it." : ""}
                </span>
                <div className="mt-bar">
                  <div className="mt-bar-fill" style={{ width: `${Math.round((liveState?.progress ?? live?.progress ?? 0) * 100)}%` }} />
                </div>
              </div>
            )}
            {meeting.message && !busyState(meeting.state) && <div className={`mt-note ${meeting.state}`}>{meeting.message}</div>}

            {meeting.speakers.length > 0 && (
              <div className="mt-speakers" onClick={(e) => e.stopPropagation()}>
                {meeting.speakers.map((sp) => (
                  <div key={sp.id} className={`mt-speaker c${colorOf(meeting.speakers, sp.id)}`}>
                    {renaming === sp.id ? (
                      <input
                        className="mt-speaker-input"
                        autoFocus
                        value={nameDraft}
                        onChange={(e) => setNameDraft(e.target.value)}
                        onBlur={() => renameSpeaker(sp.id, nameDraft)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                          if (e.key === "Escape") setRenaming(null);
                        }}
                      />
                    ) : (
                      <button
                        className="mt-speaker-name"
                        disabled={!editable}
                        title="Rename (every line follows)"
                        onClick={() => {
                          setNameDraft(sp.name);
                          setRenaming(sp.id);
                        }}
                      >
                        <span className="mt-dot" />
                        {sp.name}
                        {sp.voice && <span className="mt-known" title={`Known voice: ${sp.voice}`}>✓</span>}
                        {talk[sp.id] !== undefined && <span className="mt-share">{Math.round(talk[sp.id] * 100)}%</span>}
                      </button>
                    )}
                    {editable && (
                      <button className="mt-speaker-more" title="More…" onClick={() => setSpeakerMenu(speakerMenu === sp.id ? null : sp.id)}>
                        ▾
                      </button>
                    )}
                    {speakerMenu === sp.id && (
                      <div className="mt-menu">
                        <button
                          disabled={!sp.embedding?.length}
                          title={sp.embedding?.length ? "Later meetings label this voice with the name" : "This speaker's voice wasn't analysed (Redo → Find the speakers again)"}
                          onClick={() => rememberVoice(sp)}
                        >
                          Remember this voice as “{sp.name}”
                        </button>
                        {meeting.speakers.length > 1 && <div className="mt-menu-label">Merge {sp.name} into</div>}
                        {meeting.speakers
                          .filter((o) => o.id !== sp.id)
                          .map((o) => (
                            <button key={o.id} onClick={() => mergeSpeaker(sp.id, o.id)}>
                              {o.name}
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="mt-toolbar">
              <div className="mt-tabs" role="tablist">
                <button role="tab" aria-selected={tab === "transcript"} className={tab === "transcript" ? "active" : ""} onClick={() => setTab("transcript")}>
                  Transcript
                </button>
                <button role="tab" aria-selected={tab === "final"} className={tab === "final" ? "active" : ""} onClick={() => setTab("final")}>
                  Clean text
                </button>
              </div>
              <div className="mt-find">
                <input
                  id="mt-find"
                  type="search"
                  placeholder="Find (Ctrl+F)"
                  value={find}
                  onChange={(e) => setFind(e.target.value)}
                  onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
                    if (e.key === "Enter" && matches.length) {
                      const after = matches.find((i) => i > (current < 0 ? -1 : current)) ?? matches[0];
                      seek(lines[after].start);
                      scrollToLine(after);
                    }
                  }}
                />
                {find.trim() && <span className="mt-find-count">{matches.length}</span>}
              </div>
              <label className="mt-follow" title="Scroll to the line being played">
                <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
              </label>
            </div>

            <div
              className="mt-lines"
              ref={linesRef}
              onWheel={() => (userScrolledAt.current = Date.now())}
              onTouchMove={() => (userScrolledAt.current = Date.now())}
            >
              {lines.length === 0 && (
                <div className="mt-empty">
                  {tab === "final" ? (
                    meeting.segments.length ? (
                      <>
                        No clean text yet.{" "}
                        {editable && (
                          <button className="mt-link" onClick={() => rerun("proofread")}>
                            Proofread now
                          </button>
                        )}
                      </>
                    ) : "The clean text comes after the transcript."
                  ) : busyState(meeting.state) ? "The transcript shows here once the meeting is transcribed." : "Nothing was said (or the audio was silent)."}
                </div>
              )}
              {lines.map((l, i) => {
                const active = i === current;
                const fraction = active && l.end > l.start ? (time - l.start) / (l.end - l.start) : 0;
                const prev = i > 0 ? lines[i - 1] : null;
                const newTurn = !prev || prev.speaker !== l.speaker;
                return (
                  <div
                    key={`${l.start}-${i}`}
                    data-line={i}
                    className={`mt-line ${active ? "active" : ""} ${newTurn ? "turn" : ""} ${matches.includes(i) ? "match" : ""}`}
                  >
                    <button className="mt-time" title="Play from here" onClick={() => seek(l.start, true)}>
                      {clock(l.start)}
                    </button>
                    <div className="mt-who" onClick={(e) => e.stopPropagation()}>
                      {newTurn && (
                        <button
                          className={`mt-who-name c${colorOf(meeting.speakers, l.speaker)}`}
                          disabled={!editable}
                          title="Change the speaker of this line"
                          onClick={() => setLineMenu(lineMenu === i ? null : i)}
                        >
                          {meeting.speakers.find((s) => s.id === l.speaker)?.name ?? l.speaker}
                        </button>
                      )}
                      {!newTurn && editable && (
                        <button className="mt-who-more" title="Change the speaker of this line" onClick={() => setLineMenu(lineMenu === i ? null : i)}>
                          ·
                        </button>
                      )}
                      {lineMenu === i && (
                        <div className="mt-menu">
                          <div className="mt-menu-label">This line is from</div>
                          {meeting.speakers.map((s) => (
                            <button key={s.id} className={s.id === l.speaker ? "current" : ""} onClick={() => reassign(i, s.id)}>
                              {s.name}
                            </button>
                          ))}
                          <button onClick={() => reassign(i, "")}>+ A new speaker</button>
                        </div>
                      )}
                    </div>
                    {editingLine === i ? (
                      <textarea
                        className="mt-line-edit"
                        autoFocus
                        value={lineDraft}
                        rows={Math.max(2, Math.ceil(lineDraft.length / 80))}
                        onChange={(e) => setLineDraft(e.target.value)}
                        onBlur={() => saveLine(i)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            (e.target as HTMLTextAreaElement).blur();
                          }
                          if (e.key === "Escape") setEditingLine(null);
                        }}
                      />
                    ) : (
                      <p
                        className="mt-text"
                        title={editable ? "Click to play from here · double-click to edit" : "Click to play from here"}
                        onClick={() => seek(l.start, true)}
                        onDoubleClick={() => {
                          if (!editable) return;
                          audioRef.current?.pause();
                          setLineDraft(l.text);
                          setEditingLine(i);
                        }}
                      >
                        {active && playing && !find ? (
                          timedWords(l) ? <TimedWords words={timedWords(l)!} time={time} /> : <SpokenWords text={l.text} fraction={fraction} />
                        ) : (
                          <Highlighted text={l.text} find={find.trim()} />
                        )}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

            <footer className="mt-player">
              {detail.audio ? (
                <audio
                  ref={audioRef}
                  key={detail.audio}
                  src={detail.audio}
                  preload="metadata"
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onEnded={() => setPlaying(false)}
                  onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
                  onLoadedMetadata={(e) => setLength(e.currentTarget.duration)}
                  onError={() => setAudioError("The recording can't be played (the file is missing, or the window can't reach it).")}
                />
              ) : null}
              <button className="mt-play" disabled={!detail.audio} onClick={toggle} title="Play/pause (Space)">
                {playing ? "❚❚" : "▶"}
              </button>
              <button className="mt-skip" disabled={!detail.audio} onClick={() => seek(time - 10)} title="Back 10 s (J)">
                ↺10
              </button>
              <button className="mt-skip" disabled={!detail.audio} onClick={() => seek(time + 10)} title="Forward 10 s (L)">
                10↻
              </button>
              <span className="mt-clock">{clock(time)}</span>
              <input
                className="mt-seek"
                type="range"
                min={0}
                max={length || meeting.durationMs / 1000 || 0}
                step={0.1}
                value={time}
                disabled={!detail.audio}
                onChange={(e) => seek(Number(e.target.value))}
                aria-label="Position"
              />
              <span className="mt-clock">{clock(length || meeting.durationMs / 1000)}</span>
              <select className="mt-speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="Speed">
                {SPEEDS.map((s) => (
                  <option key={s} value={s}>
                    {s}×
                  </option>
                ))}
              </select>
              {audioError && <span className="mt-audio-error">{audioError}</span>}
              {!detail.audio && meeting.state === "recording" && <span className="mt-audio-error">Recording…</span>}
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
