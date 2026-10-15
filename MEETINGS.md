# Meetings: recording, speakers, proofread, library

Live captions stay as they are. **Meeting mode** (a toggle on the captions
bar, default in Settings → Captions) adds:

- the microphone next to system audio, as two tracks: **Me** and the others;
- the whole recording kept on disk, with every caption and its time;
- **Save**: a folder per meeting, a better transcription of the whole audio,
  speakers (diarization), and an AI proofread of the transcript;
- a **Meetings** window: the saved meetings, a player that highlights the
  words being played, speaker renaming, editing, export, delete.

## Files

One folder per meeting under `meetingsDir` (default
`~/Documents/GhostPen/Meetings/`), named `YYYY-MM-DD_HHMM` (the title lives in meeting.json):

| File | What |
| --- | --- |
| `meeting.json` | the source of truth (below) |
| `audio.wav` | 16 kHz 16-bit PCM; stereo when the mic was on (left: others, right: me) |
| `others.wav`, `me.wav` | the tracks while recording; merged into `audio.wav` on save |
| `transcript.md` | the transcript with times and speakers (rewritten from meeting.json) |
| `final.md` | the proofread text (rewritten from meeting.json) |

`meeting.json`:

```json
{ "version": 1, "title": "…", "startedAt": 1760000000000, "durationMs": 0,
  "state": "recording|saving|transcribing|diarizing|proofreading|ready|error",
  "message": "", "mic": true, "language": "en", "model": "base",
  "speakers": [{ "id": "me", "name": "Me" }, { "id": "s1", "name": "Speaker 1", "voice": "" }],
  "segments": [{ "start": 0.0, "end": 2.4, "speaker": "s1", "text": "…" }],
  "final": [{ "start": 0.0, "end": 9.1, "speaker": "s1", "text": "…" }] }
```

`segments` are whisper's (time-aligned, what the player highlights);
`final` is the proofread, one entry per speaker turn (a run of segments by
one speaker), so the clean text still follows the player turn by turn.

## Phases

### 1. Meeting mode (GhostPen)

- [x] Settings: `meetings.{enabled, dir, mic, proofread, model}`; the mic
      is the dictation microphone.
- [x] `src/meetings.zig`: the recorder (two capture threads, each track
      streamed to its WAV; captions from both, labelled), the library
      (list/read/rename/delete/edit), the save pipeline (merge the tracks →
      transcribeSegments over the whole audio, in windows → speakers →
      proofread per turn → files), progress events.
- [x] Captions bar: Meeting toggle, recording time, Save; captions show the
      speaker ("Me").
- [x] Proofread: a meeting prompt, turns sent in numbered batches that fit
      the model's context; a batch whose answer doesn't line up keeps the
      raw text.

### 2. Meetings window

- [x] A window (`#/meetings`, tray → Meetings): the list (search, date,
      length, state), a meeting's page: title (rename), player (play/pause,
      seek, speed, skip ±10 s, keyboard), transcript tabs **Transcript**
      (segments) / **Clean text** (final), the current segment highlighted
      and scrolled to; click a line to play from it.
- [x] Speakers: rename (all their lines), merge two, reassign a line, colour.
- [x] Edit a line's text; re-run the proofread; re-run the speakers.
- [x] Export: copy/save Markdown, SRT, plain text; open the folder; delete.
- [x] Audio served by `oriel.media_server` (127.0.0.1, ranges), started while
      the window is open.

### 3. Speakers (Oriel `speakers` module, then GhostPen)

- [x] In Oriel (`speakers` branch): `oriel.speakers` over voice-detect.cpp
      (MIT) on the shared ggml tree, clustering in Zig, a model catalog.
      WeSpeaker ResNet34 by default (see "Speaker model" below for why not
      ECAPA); 3 s windows.
- [x] GhostPen: diarize the others' track on save; the mic track is "Me".
- [x] Known voices: a speaker named in the Meetings window can be saved as
      a voice (its embedding centroid, `voices.json` in the app data); later
      meetings label matching speakers with the name.
- [x] Live labels in the overlay: online clustering of each caption chunk
      (less accurate; the save redoes it).
- [ ] Later: overlapping speech (pyannote segmentation).

## Speaker model (research, 2026-10-15)

**Measured (2026-10-15), and what was chosen.** voice-detect.cpp feeds
every model Kaldi fbank. Its ECAPA GGUF then hardly tells people apart on
real voices (LibriSpeech, 3 s halves: one man 0.80, two women 0.70, a man
and a woman 0.45), and 1.5 s windows of one voice were only 0.54 alike.
WeSpeaker ResNet34 gives 0.73, 0.22 and 0.08, so it is the default, with
3 s windows every 1.5 s. On three one-minute LibriSpeech conversations it
found 3, 4 and 1 speakers for 3, 3 and 1, with 10/12, 12/14 and 9/9
segments right. The misses are segments where whisper joined the end of
one person's turn with the next. A synthetic three-voice meeting (Piper)
gave 3 for 3. The notes below are the earlier research; CAM++ was not
ported (voice-detect.cpp already had working encoders).

- **Embedding: 3D-Speaker CAM++ `zh_en_16k-common_advanced`.** Apache-2.0
  code and weights; 7.2M params; 192-d output; Kaldi fbank in. Ops: conv2d,
  dilated conv1d, avg pooling, sigmoid gating, mean+std stats pooling. All
  of them are in Oriel's vendored ggml; batch norm is folded at conversion,
  and conv weights are F16 like Kokoro's. Reference port to check against
  (MIT, ggml, cos ≥ 0.9999): localai-org/voice-detect.cpp, with GGUFs at
  huggingface.co/mudler/voice-detect-gguf.
- **Fbank (computed in Zig):**
  - 16 kHz audio; 25 ms frames with a 10 ms shift; `snip_edges`.
  - Per frame: remove the DC offset, pre-emphasis 0.97, Povey window,
    512-point FFT, power spectrum.
  - 80 mel bins from 20 Hz to Nyquist; `log(max(e, FLT_EPSILON))`; no
    dither.
  - Mean subtraction (CMN) per embedded window.
- **Seg-pool:** `avg_pool1d(k=100, ceil_mode)` averages a partial last
  segment over its real frames: compute it on the host, or pad and divide.
- **Clustering:**
  - Windows of 1.5 s with a 0.75 s step, inside VAD speech.
  - Fewer than 40 windows: agglomerative clustering, average linkage on
    cosine, threshold about 0.4–0.5.
  - Otherwise: spectral clustering, the speaker count from the eigengap
    (1–15), then k-means.
  - Afterwards: merge clusters whose centroids are above 0.8 cosine, and
    reassign clusters with 4 windows or fewer.
  - Known voices: centroid cosine above about 0.5–0.6 (tune per model).
  - Live: nearest centroid when above the threshold, else a new speaker;
    running mean.
- **Overlap (later):** pyannote segmentation-3.0. MIT, but gated on
  Hugging Face; sherpa-onnx mirrors it ungated. SincNet, then a 4-layer
  BiLSTM (128), then 7 powerset classes; 10 s windows. The LSTM can follow
  Kokoro's pattern.

## Tests

- `src/wav.zig`, `src/meeting_store.zig`, `src/meetings.zig`: unit tests
  (`zig build test`; the build runner's `--listen` mode reports a failure
  even when every test passes, so run the test binary directly).
- `tests/e2e-meetings.sh`: headless. Meeting mode over tests/speech.wav,
  then stop, the save pipeline with the mock AI, the files on disk, the
  Meetings window, and the audio served with ranges (and no path outside
  the folder).
- Not covered headless: playback itself, and the stereo-to-mono mix
  through WebAudio (it needs the media server's CORS to admit the page).

## Notes

- Playing the meeting through speakers instead of a headset puts the others
  in the mic track too: the UI says so.
- Recordings are private: the media server only runs while the Meetings
  window is open and only answers on 127.0.0.1 with the right Host.
