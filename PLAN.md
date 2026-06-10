# Shortstop — Implementation Plan (v2)

> A Claude Code skill that turns a raw recording into a ready-to-post 9:16 YouTube Short, hands-off.
> Drop a clip in `input/`, invoke the skill, get a polished vertical `.mp4` with word-level captions back a few minutes later.

This is a **build-from-scratch roadmap** for a greenfield repo. Every open question from v1 has been resolved — decisions and rationale live in the [Decision Record](#10-decision-record). Inline **Assumption:** markers flag the remaining gaps filled by judgment.

---

## 1. Overview

**Problem.** Editing short-form video by hand is slow and repetitive: transcribe, find the dead air, cut filler and retakes, reframe to vertical, caption every word, normalize audio, render, eyeball it, fix the rough cuts, export. For a talking-head or screen-recording creator this is 30–90 minutes of mechanical work per clip that follows the same rules every time.

**Goal.** Automate the entire loop inside Claude Code. The user drops a raw clip into `input/`, invokes the skill, and a few minutes later a polished, vertical, captioned `.mp4` lands in `output/`. **Claude is the orchestrator**: it runs the deterministic pipeline scripts as tools (probe → transcribe → silence → track → render → QA) and applies its own judgment only where judgment is needed — deciding *what to cut* and *how to close QA gaps*. Scripts never call an LLM.

**Definition of done (a successful delivered `.mp4`).** A delivered clip:
1. Is a valid, playable H.264/AAC `.mp4` at **1080×1920 (9:16)**, constant frame rate at the source-derived fps (or source aspect/resolution when `aspect: "source"` is configured).
2. Has dead air, filler words, false starts, and abandoned retakes removed, with every cut placed inside detected silence with padding clearance — **no clipped syllables**.
3. Keeps the subject framed: tracked center-crop for talking heads, blurred-pad fallback when no face is present (screen recordings).
4. Has burned-in word-level karaoke-style captions in the platform-safe area (config-disableable).
5. Has normalized, click-free audio: **−14 LUFS integrated, true peak ≤ −1 dBTP**, no level jumps at edit points.
6. Passes the [QA loop](#8-qa-loop-design) within 5 fix attempts, OR is delivered with an explicit `QA_REPORT.md` flagging unresolved *soft* gaps. A candidate with unresolved *hard* gaps is **never** delivered to `output/`.
7. Is replayable: the EDL and all intermediates are archived in `runs/<run-id>/`; the same EDL + config always renders the same output. (Claude's cut *choices* may vary run-to-run; validity is enforced deterministically.)

**Non-goal of this document.** This plan does not write the skill. It is the spec a competent developer (or Claude, in a later session) executes phase by phase, one-shot.

---

## 2. Goals & Non-Goals

### Goals
- **One-command operation.** Invoking the skill on a dropped clip produces a finished Short with zero further input. An optional `--review-edl` mode pauses to show the cut list before rendering.
- **Hands-off cut decisions.** Filler, long pauses, false starts, and abandoned retakes are removed automatically based on transcript + silence analysis.
- **Vertical-first output.** 1080×1920 with subject tracking (static smoothed crop path; no per-frame jitter). Source-aspect passthrough available via config.
- **Word-level captions by default.** Karaoke-style burned-in captions generated from the existing Whisper word timestamps, styled via config.
- **ffmpeg-only render path.** No browser, no GPU, no per-seat licensing. The EDL contract is renderer-agnostic so a richer engine (e.g. Remotion) can slot in at v2 without touching stages 0–4.
- **Self-configuring distribution.** Ships as a skill folder that drops into `.claude/skills/` and bootstraps its own dependencies on first run.
- **Linux-native.** One toolchain, no cross-OS abstraction.
- **Bounded, self-correcting QA.** Candidate is measured against absolute gates plus reference-derived style tolerances; defects are auto-fixed within a 5-attempt ceiling; failure is reported, never silently shipped.
- **Inspectable intermediates.** Every stage writes a durable, schema-validated artifact so any run can be debugged or replayed.

### Non-Goals
- **No content generation.** Shortstop edits what was recorded; no scripts, B-roll, stock footage, or narration.
- **No music, transitions, or motion graphics.** v1 output is hard cuts (the standard Shorts jump-cut aesthetic), captions, and reframing. Nothing else.
- **No multi-clip assembly.** One raw clip → one short.
- **No upload/posting.** Shortstop produces a file.
- **No cloud anything.** Transcription, tracking, and rendering are fully local — no API keys, no privacy questions, no network dependency after bootstrap. (Decision Record #7.)
- **No cross-platform support in v1.** Linux only.
- **No GPU requirement.** CPU-only is the baseline; GPU is never assumed.
- **No real-time / streaming.** Batch processing of recorded files only.
- **No raw inputs over ~20 minutes.** Enforced at probe with a clear rejection message (Decision Record #6). This guarantees the transcript fits a single Claude context window — no chunking machinery in v1.

---

## 3. Architecture

### Control flow — Claude is the orchestrator

The skill's `SKILL.md` is a playbook **Claude follows in-session**. Claude runs each deterministic stage as a subprocess, reads its artifact, and performs the two judgment steps itself (cut decisions, QA gap fixes) using the versioned prompts in `prompts/`. **No script ever invokes Claude** — there is no `claude -p` subprocess, no API key, no hidden LLM cost. This is the inverse of v1's design and is load-bearing: it is the only way a skill gets LLM judgment for free inside the user's existing session.

### Pipeline (stage diagram)

```
 input/raw.mp4 ──▶ STAGE 0 — PROBE & NORMALIZE          probe.mjs        probe.json
                   ffprobe: rational fps, dims, rotation,
                   VFR detection, audio streams, duration.
                   Rejects >20 min. Pre-transcodes to CFR
                   H.264 intermediate ONLY if VFR / rotated /
                   exotic codec.
                        │
        ┌───────────────┼─────────────────┐        (1, 2, 3 are independent — Claude
        ▼               ▼                 ▼          may run them in parallel)
 STAGE 1 — TRANSCRIBE  STAGE 2 — SILENCE  STAGE 3 — TRACK
 faster-whisper,       auto-calibrated    YuNet face detect @5 fps,
 word timestamps       silencedetect      smoothed 9:16 crop path,
 transcribe.py         silence.mjs        blur-pad fallback flag
 transcript.json       silence.json       track.py → track.json
        └───────────────┼─────────────────┘
                        ▼
                   STAGE 4 — CUT DECISIONS         ← CLAUDE (in-session,
                   transcript + silence → keep/      prompts/cut_decisions.md)
                   remove reasoning → draft EDL →
                   build_edl.mjs validates, pads,
                   snaps to silence midpoints      edl.json
                        │
                        ▼
                   STAGE 5 — CAPTIONS               build_captions.mjs
                   kept words mapped to output
                   timeline → karaoke .ass          captions.ass
                        │
                        ▼
                   STAGE 6 — RENDER (ffmpeg)        render.mjs
                   pass A: cuts+concat+micro-fades → mezzanine
                   pass B: tracked crop + scale +
                   captions burn + 2-pass loudnorm  candidate_a<N>.mp4
                        │
                        ▼
              ┌──▶ STAGE 7 — QA MEASURE             qa.mjs (deterministic)
   fix loop   │    absolute gates + reference
  (≤ 5 fixes, │    style tolerances                 qa_report_a<N>.json
   Claude     │         │
   decides    │    GAP  │  PASS
   the fix)   └─────────┤
                        ▼
                   DELIVER → output/<stem>-<runid>.mp4
                   (+ QA_REPORT.md if soft gaps remain;
                    hard gaps ⇒ report only, no delivery)
```

### Data-flow & artifact contracts

Every stage writes into `runs/<run-id>/` in the **host project's working directory** (run-id = `YYYYMMDD-HHmmss-<4char>`). `output/` only ever receives final deliverables.

| # | Artifact | Producer | Consumer(s) | Contract (key fields) |
|---|----------|----------|-------------|------------------------|
| 0 | `probe.json` | Stage 0 | 1,2,3,4,6,7 | `{ fps_num, fps_den, fps, width, height, rotation, display_width, display_height, duration_s, vfr, normalized_path\|null, audio_streams: [{index, codec, sample_rate, channels}], audio_source }` — fps as **rational**; `display_*` are rotation-corrected; `normalized_path` set when a CFR intermediate was produced (all downstream stages then read it instead of the raw file); `audio_source` records the mixdown decision (`"mix"` or a stream index). |
| 1 | `transcript.json` | Stage 1 | 4,5,7 | `{ language, duration_s, segments: [{ id, start, end, text, words: [{ word, start, end, prob }] }] }` — word-level timestamps mandatory. |
| 2 | `silence.json` | Stage 2 | 4 | `{ noise_floor_db, threshold_db, min_silence_s, regions: [{ start, end, dur }] }` — sorted, non-overlapping, source-time seconds; calibration values recorded. |
| 3 | `track.json` | Stage 3 | 6,7 | `{ mode: "face"\|"fallback", sample_fps, detections: [{ t, cx, cy, w, h, conf }], crop_path: [{ t, x, y }], crop_w, crop_h, coverage }` — `crop_path` is the **smoothed** per-keyframe top-left of the 9:16 window in source pixels; `coverage` = fraction of sampled frames with a confident detection. |
| 4 | `edl.json` | Stage 4 | 5,6,7 | **Keep-list.** `{ source, keep: [{ start, end, reason }], removed: [{ start, end, kind, reason }], notes }` — sorted, non-overlapping, padded, snapped to silence midpoints (see §5.5). |
| 5 | `captions.ass` | Stage 5 | 6 | ASS subtitles in **output time**, one Dialogue per caption line, karaoke `\k` tags per word, style from config. |
| 6 | `candidate_a<N>.mp4` | Stage 6 | 7 | One per QA attempt N (0 = first render). H.264/AAC, 1080×1920 (or source aspect), CFR. |
| 7 | `qa_report_a<N>.json` | Stage 7 | Claude / deliver | `{ verdict: "pass"\|"gap", attempt, score, signals: {...}, gaps: [{ signal, severity: "hard"\|"soft", observed, target, suggested_fix }] }` |
| — | `output/<stem>-<runid>.mp4` | Deliver | user | Byte-for-byte the best passing candidate. Never clobbers prior edits. |
| — | `output/<stem>-<runid>.QA_REPORT.md` | Deliver | user | Written when soft gaps remain at the ceiling, or alone (no mp4) when hard gaps block delivery. |

**Design rule — keep-list over cut-list.** The EDL stores segments to *keep*. Stage 6 is pure concatenation; coverage is a trivial sum.

**Design rule — source-time everywhere.** All timestamps in artifacts 1–4 are source seconds (floats). Conversion to output time happens in exactly two places: `build_captions.mjs` (word → output time) and `render.mjs` (crop path → output time), both via `lib/timecode.mjs` using the exact rational fps.

**Design rule — one snapping authority.** All boundary padding/snapping happens in `build_edl.mjs` and nowhere else. Stages 5–6 treat `edl.json` boundaries as final.

---

## 4. Repository / Folder Layout

The repo is the **dev workspace**; `skill/` is the **distributable** — the folder a user copies (or symlinks) to `<project>/.claude/skills/shortstop/` or `~/.claude/skills/shortstop/`. There is no separate slash-command file: the skill itself is discoverable and invocable (`/shortstop`, or natural language: "edit this clip", "make a short from input/take3.mp4").

```
shortstop/                          # dev repo
├── README.md                       # Quickstart: install skill → drop clip → invoke → done
├── PLAN.md                         # This file
│
├── skill/                          # ───── THE DISTRIBUTABLE SKILL FOLDER ─────
│   ├── SKILL.md                    # Manifest + orchestration playbook (see annotation)
│   ├── package.json                # Node deps: ffmpeg-static, ffprobe-static, execa, ajv
│   ├── .nvmrc                      # Node ≥ 20
│   │
│   ├── config/
│   │   ├── default.config.json     # All tunables (see §4.1); user overrides via
│   │   │                           #   <project>/shortstop.config.json (merged over defaults)
│   │   └── config.schema.json
│   │
│   ├── scripts/
│   │   ├── bootstrap.mjs           # First-run setup (§6); writes .shortstop-ready
│   │   ├── doctor.mjs              # Dependency health check, actionable fixes
│   │   ├── probe.mjs               # Stage 0 — probe + conditional normalize
│   │   ├── transcribe.py           # Stage 1 — faster-whisper
│   │   ├── silence.mjs             # Stage 2 — auto-calibrated silencedetect
│   │   ├── track.py                # Stage 3 — YuNet face track → crop path
│   │   ├── build_edl.mjs           # Stage 4 validator — pad, snap, reject, coverage
│   │   ├── build_captions.mjs      # Stage 5 — EDL+transcript → captions.ass
│   │   ├── render.mjs              # Stage 6 — ffmpeg pass A + pass B + assertions
│   │   ├── qa.mjs                  # Stage 7 — measure candidate vs gates+reference
│   │   └── lib/
│   │       ├── spawn.mjs           # execa array-spawn wrapper (no shell strings)
│   │       ├── ffmpeg.mjs          # locate/validate ffmpeg+ffprobe; shared audio-source
│   │       │                       #   resolution (same mixdown for whisper & render)
│   │       ├── venv.mjs            # locate python, manage .venv invocations
│   │       ├── timecode.mjs        # rational fps ↔ frames ↔ seconds (single source of truth)
│   │       └── artifacts.mjs       # schema-validated read/write of every artifact
│   │
│   ├── prompts/
│   │   ├── cut_decisions.md        # Stage 4 prompt template Claude applies to itself
│   │   └── qa_gap_fix.md           # Fix-loop prompt template
│   │
│   ├── schemas/                    # probe, transcript, silence, track, edl, qa_report
│   │   └── *.schema.json
│   │
│   ├── assets/
│   │   └── fonts/CaptionFont.ttf   # Bundled OFL font (e.g. Montserrat Bold) for libass
│   │
│   └── (created by bootstrap, gitignored:)
│       ├── node_modules/  .venv/  models/yunet.onnx  models/whisper/  .shortstop-ready
│
├── tests/                          # dev-only, not shipped
│   ├── fixtures/                   # generated tiny clips + golden artifacts (§4.2)
│   ├── fixtures.mjs                # fixture generator (espeak-ng + ffmpeg, see §4.2)
│   └── *.test.mjs                  # per-stage unit tests + e2e smoke test
│
└── .github/ / CI as desired
```

**Workspace dirs** (`input/`, `output/`, `reference/`, `runs/`) live in the **host project's CWD**, not inside the skill folder. The skill creates them on demand. `runs/` is pruned to `config.runs.keep_last` (default 10) after each successful delivery.

**`SKILL.md` annotation (the spine).** Frontmatter: `name: shortstop`, `description:` covering the trigger phrases ("edit a raw video", "make a short", "polish this clip", clip dropped in `input/`). Body is the playbook Claude executes:
1. If `.shortstop-ready` missing → run `bootstrap.mjs`, streaming progress ("one-time setup").
2. **Fail fast on prerequisites**: abort immediately (before any heavy work) if `reference/` has no video, with instructions to add a style-exemplar clip.
3. Resolve the target clip (named file, else newest in `input/`). Create run dir.
4. Run Stage 0; surface rejection (>20 min, no video stream) verbatim.
5. Run Stages 1–3 (independent — may run in parallel).
6. **Stage 4 — Claude itself**: read `transcript.json` + `silence.json` + config, apply `prompts/cut_decisions.md`, write a draft EDL, pipe it through `build_edl.mjs`; on validation rejection, repair and retry (max 2 repairs, then abort with the validator's message).
7. If `--review-edl` (or the user asked to review): present the removed-segments table (timestamp, kind, reason) and wait for approval.
8. Run Stages 5–6, then Stage 7.
9. **QA loop — Claude decides fixes** (§8): deterministic remediations first, judgment fixes via `prompts/qa_gap_fix.md`, ≤ 5 fix attempts, score-based no-progress guard.
10. Deliver per §8 rules; report the outcome with the cut summary (n cuts, time removed, final duration); prune old runs.

### 4.1 Config surface (`default.config.json`)

```jsonc
{
  "input":    { "max_minutes": 20 },
  "whisper":  { "model": "small", "language": "auto" },
  "silence":  { "auto_calibrate": true, "offset_db": 10, "min_silence_s": 0.5,
                "fallback_threshold_db": -30 },
  "cut":      { "fillers": ["um","uh","like","you know","sort of","kind of","I mean"],
                "max_pause_s": 0.8, "pad_s": 0.1, "aggressiveness": "normal",
                "target_duration_s": null },
  "aspect":   { "mode": "9:16", "no_face_fallback": "blur-pad",   // or "center-crop"
                "out_width": 1080, "out_height": 1920 },
  "captions": { "enabled": true, "max_words_per_line": 4, "max_line_s": 1.6,
                "font": "CaptionFont", "size": 96, "margin_v": 420,
                "primary_color": "&H00FFFFFF", "highlight_color": "&H0000D7FF",
                "outline": 5 },
  "audio":    { "target_lufs": -14, "true_peak_db": -1, "track": "mix",  // or stream index
                "junction_fade_s": 0.01 },
  "render":   { "crf": 18, "preset": "medium", "mezzanine_crf": 12 },
  "qa":       { "max_fix_attempts": 5, "duration_tolerance_frames": 1,
                "lufs_tolerance": 2, "shorts_max_s": 180,
                "pacing_tolerance": 0.5, "framing_tolerance": 0.15,
                "verify_transcript": false },
  "runs":     { "keep_last": 10 }
}
```

### 4.2 Test fixtures (generated, not sourced)

`tests/fixtures.mjs` builds every fixture deterministically so Phases 2–9 are testable one-shot:
- **Speech fixtures:** `espeak-ng` renders scripted lines containing planted filler ("um", a false start, a retake) to WAV; known silences are inserted with ffmpeg `apad`/`anullsrc` concat. Ground-truth cut points are therefore known by construction.
- **Video track:** ffmpeg `testsrc2` for non-face fixtures; for tracking fixtures, a CC0 face photo animated with `zoompan` (slow horizontal drift) muxed over the speech WAV — gives YuNet a real face with a known motion path.
- **Pathological fixtures:** a VFR clip (`-vsync vfr` re-encode), a rotated clip (`-metadata:s:v rotate=90`), a 21-minute clip (assembled via stream-copy concat, for the cap test), a 29.97 NTSC clip.
- A small real reference clip fixture for QA tests (any CC0 short-form clip, committed at low resolution).

---

## 5. Component Specs

### 5.1 Stage 0 — Probe & Normalize

| | |
|---|---|
| **Responsibility** | Extract exact technical metadata; detect and repair the three real-world input hazards (VFR, rotation, exotic codecs); enforce the 20-minute cap; resolve the audio source. |
| **Tool** | `ffprobe` for metadata; `ffmpeg` for the conditional normalize pass. |
| **Emits** | `probe.json`; optionally `runs/<id>/normalized.mp4`. |
| **VFR detection** | Compare `r_frame_rate` vs `avg_frame_rate`; mismatch > 0.5% ⇒ VFR. Screen recordings (OBS) and phone footage are commonly VFR, and the source-seconds × rational-fps frame math in §3 is invalid on VFR input — so VFR ⇒ **normalize to CFR** at the nearest standard rate to `avg_frame_rate` (whitelist: 24000/1001, 24, 25, 30000/1001, 30, 50, 60000/1001, 60). |
| **Rotation** | Read the display-matrix side data. Rotation present ⇒ normalize (bake the rotation) so all downstream pixel math uses real display dimensions. `display_width/height` in `probe.json` are always rotation-corrected. |
| **Exotic codec** | Decode probe failure or non-H.264/HEVC/VP9/AV1 video ⇒ normalize. |
| **Normalize pass** | Single ffmpeg re-encode: H.264 CRF 12 (near-lossless mezzanine quality), CFR via `-fps_mode cfr -r <rational>`, autorotate baked, audio stream-copied. `probe.json.normalized_path` points at it; **all downstream stages read it instead of the raw file**. Clean inputs skip this entirely (fast path — Decision Record #12). |
| **Audio source** | Multi-audio-stream inputs (OBS mic + system audio) are resolved here once: `config.audio.track` = `"mix"` (default — `amix` all streams) or a stream index. The decision is recorded as `probe.audio_source` and **`lib/ffmpeg.mjs` applies the identical mixdown for both Whisper extraction and the render**, so Claude cuts what the viewer hears. |
| **Cap & rejection** | Duration > `config.input.max_minutes` ⇒ exit non-zero with a one-line user-facing message. Same for no-video-stream inputs. **Assumption:** single video stream; multi-stream uses `v:0`. |

### 5.2 Stage 1 — Transcription

| | |
|---|---|
| **Responsibility** | Word-level, timestamped transcript for Stage 4 reasoning and caption generation. |
| **Tool** | **`faster-whisper`** (CTranslate2): 4–5× faster than reference Whisper on CPU, word timestamps, no GPU. Default model `small`, configurable. Local-only — no cloud fallback (Decision Record #7). |
| **Emits** | `transcript.json`. |
| **Key params** | `word_timestamps=True`, `vad_filter=True` (Silero VAD suppresses hallucinated text in silence), `beam_size=5`, language auto-detect. Audio input: 16 kHz mono WAV extracted via the shared audio-source mixdown. |
| **Notes** | Word `prob` is preserved so Stage 4 treats low-confidence regions cautiously. **Whisper word timestamps carry ±50–200 ms slop, worst at word ends** — this is why `build_edl.mjs` pads and snaps to silence midpoints rather than trusting `word.end` (§5.5). The 20-min cap guarantees single-window Stage 4 — no chunking. |

### 5.3 Stage 2 — Silence Map (auto-calibrated)

| | |
|---|---|
| **Responsibility** | Find dead-air regions; calibrate the threshold to the clip's actual noise floor so quiet rooms, fans, and laptop mics all work without manual tuning. |
| **Tool** | `ffmpeg astats` (calibration) + `silencedetect` (detection). |
| **Emits** | `silence.json` (calibration values recorded for debuggability). |
| **Calibration** | Measure per-window RMS over the clip (e.g. `astats=metadata=1:reset=1` at 0.5 s windows); noise floor = a low percentile (p10) of window RMS; threshold = `floor + config.silence.offset_db` (default +10 dB), clamped to [−50, −20] dB. If calibration fails (e.g. wall-to-wall music), fall back to `fallback_threshold_db` and record `"calibrated": false`. |
| **Empty-map fallback** | If zero silences are detected (continuous background noise/music), Stage 4 is told explicitly: cuts then rely on word boundaries + padding only, and `build_edl.mjs` skips silence-snapping. The QA report notes the degraded mode. |

### 5.4 Stage 3 — Subject Track (reframe path)

| | |
|---|---|
| **Responsibility** | Produce the smoothed 9:16 crop path that keeps the speaker framed (Decision Record #3: tracking in v1). |
| **Tool** | **OpenCV YuNet face detector** (`cv2.FaceDetectorYN`, tiny ONNX model ~230 KB, CPU-fast, arm64-safe) inside the existing Python venv — chosen over mediapipe for wheel availability and footprint. `bootstrap.mjs` downloads the model to `models/yunet.onnx`. |
| **Emits** | `track.json`. |
| **Algorithm** | 1) Decode at `sample_fps=5`. 2) Detect; pick the **largest** face, with stickiness (prefer the face nearest the previous pick — prevents flicker between two people). 3) Gaps ≤ 2 s: linear interpolate; longer: hold last position. 4) Smooth the center path: dead-zone (crop doesn't move while the face center stays within the central 20% of the crop) + critically-damped ease toward the target when it exits — eliminates per-frame jitter. 5) Clamp crop to frame; round x/y to even pixels (yuv420). 6) Crop geometry: `crop_h = display_height`, `crop_w = crop_h * 9/16`. |
| **Fallback** | `coverage < 0.5` (screen recordings, slides) ⇒ `mode: "fallback"`: render uses `config.aspect.no_face_fallback` (`blur-pad`: full frame scaled into 1080×1920 over a blurred, zoomed copy of itself; or `center-crop`). |
| **Notes** | Tracking runs **once on the full source**, before cut decisions — QA re-renders never re-track. Whole-clip cost at 5 fps is minutes-scale worst case on CPU for a 20-min input. **Assumption / doc note:** a 1080p 16:9 source yields a 607×1080 crop upscaled ~1.8× (lanczos) — acceptable for v1; README recommends ≥1440p/4K sources for native-sharp crops. `aspect.mode: "source"` skips this stage entirely. |

### 5.5 Stage 4 — Cut Decisions (the AI step) + `build_edl.mjs`

| | |
|---|---|
| **Responsibility** | Decide what to remove (filler, long pauses, false starts, abandoned retakes) and emit a validated keep-list EDL. |
| **Who** | **Claude, in-session**, applying `prompts/cut_decisions.md` to `transcript.json` + `silence.json` + config. Distinguishing a dramatic pause from dead air, or the better of two takes, is an LLM-shaped problem. Claude emits *decisions in source seconds*; never frame math. |
| **The prompt template MUST contain** | 1) Role: senior short-form editor. 2) Transcript with word timestamps + confidence. 3) Silence map (+ degraded-mode flag). 4) Cut rules: fillers from config, pauses > `max_pause_s`, false starts, retakes (keep the last clean attempt). 5) Hard constraints: keep-segments only, sorted, non-overlapping, never mid-word, preserve meaning and cadence, do not cut for length unless `target_duration_s` is set. 6) Output contract: strict JSON per `edl.schema.json`, each removal tagged `kind` + one-line `reason`. 7) **"Only cut what the rules justify. When unsure, keep it."** 8) Low-confidence words (`prob < 0.5`) are kept unless inside a silence region. |
| **`build_edl.mjs` — the deterministic guardrail and the *only* snapping authority** | 1) Schema-validate; reject overlap/out-of-order/out-of-range. 2) **Pad** each keep boundary outward by `pad_s` (default 100 ms) — this absorbs Whisper's word-timestamp slop so syllables are never clipped. 3) **Snap** each padded boundary to the **midpoint of the nearest silence region** when one lies within the removed gap; if the gap contains no silence, keep the padded word boundary. 4) Merge keeps that now touch/overlap; drop removals shorter than 2 frames. 5) Verify every transcript word is either fully inside a keep or fully inside a removal (no straddling). 6) Emit coverage stats (kept %, removed % by kind). On rejection, print a machine-readable reason — Claude repairs and resubmits (max 2 repairs). |

### 5.6 Stage 5 — Captions

| | |
|---|---|
| **Responsibility** | Word-level karaoke captions, on by default (Decision Record #2). |
| **Tool** | `build_captions.mjs` → ASS (libass), burned in Stage 6 via the `subtitles` filter. ASS karaoke `\k` tags give the per-word highlight pop without any browser/renderer dependency. |
| **Emits** | `captions.ass` in **output time**: for each kept word, `out_t = word.start − keep.start + Σ(prior keep durations)` via `lib/timecode.mjs`. |
| **Line grouping** | Break lines at: `max_words_per_line` (default 4), `max_line_s` (1.6 s), sentence punctuation, or a crossed cut junction. Style from config: bundled bold font (registered via `subtitles=...:fontsdir=assets/fonts` — never depends on system fonts), white fill + black outline, highlight color on the active word, `Alignment=2` bottom-center with `MarginV=420` (clear of the Shorts UI overlay zone). |
| **Notes** | `captions.enabled: false` skips the stage and the burn filter. Captions are regenerated per QA attempt only if the EDL changed. |

### 5.7 Stage 6 — Render (ffmpeg, two passes)

| | |
|---|---|
| **Responsibility** | EDL + crop path + captions → candidate mp4. ffmpeg-only (Decision Record #1): no Chromium, no license, exact rational fps, fastest CPU path. |
| **Pass A — cut & concat (mezzanine)** | One `filter_complex`: per keep-segment `trim/setpts` + `atrim/asetpts`, **micro-fades** `afade=in:d=0.01` / `afade=out` at each segment's audio edges (10 ms — kills clicks without borrowing audio from removed regions; cuts already land in silence, so nothing audible is lost and `duration == Σkeep` stays exact), then `concat=n=K:v=1:a=1`. Encode: H.264 CRF 12 + PCM audio in MKV (mezzanine — no AAC double-encode). |
| **Pass B — finish** | Video: dynamic crop via **per-output-frame `sendcmd`** file generated from `track.json` remapped source→output time (`sendcmd=f=crop.cmd,crop@dyn=...`), `scale=1080:1920:flags=lanczos`, `subtitles=captions.ass:fontsdir=...`. (Fallback mode: blur-pad graph instead of crop.) Audio: **two-pass `loudnorm`** — measure pass (`print_format=json`) then apply pass with `measured_*` values (linear normalization, no pumping), followed by `aresample=<source_rate>` (loudnorm upsamples to 192 kHz internally). Encode: H.264 `crf`/`preset` from config, AAC, `+faststart`. |
| **Incremental re-render** | QA fixes that change only audio params or captions re-run **pass B only**; EDL changes invalidate both passes. |
| **Post-render assertions (fail the stage, not QA)** | `ffprobe` the candidate: fps rational == expected, dims == 1080×1920 (or source), `duration == Σkeep ± 1 frame`, audio stream present at source sample rate. |

### 5.8 Stage 7 — QA Measure

Deterministic measurement only (`qa.mjs`); gap *decisions* are Claude's, in the loop (§8). Consumes `candidate_a<N>.mp4`, the cached reference signals, `edl.json`, `track.json`, `probe.json`.

The **reference clip is required** (Decision Record #4): the playbook aborts at invocation start if `reference/` is empty. Reference signals (pacing, cut density, loudness character) are computed once and cached in `reference/.shortstop-cache/<content-hash>.json`. The reference is a *style exemplar*: it tunes **soft tolerances only**. It is **never** compared on duration — edit duration is determined by the raw footage's content, not by an unrelated clip (this was the v1 flaw; see Decision Record).

---

## 6. Environment & Setup (Linux)

Linux-only. Node runs the orchestrator scripts; Python (venv) hosts faster-whisper and OpenCV. **No browser, no GPU.**

| Dependency | Role | Acquisition |
|---|---|---|
| **Node ≥ 20** (`.nvmrc`) | all `.mjs` stages | distro/nvm (only manual prereq) |
| **ffmpeg + ffprobe** | probe, silence, render, loudnorm, libass burn | **`ffmpeg-static`/`ffprobe-static` npm packages** (pinned, no system pkg-mgr); PATH fallback validated by doctor (must have `silencedetect`, `loudnorm`, `subtitles`/libass) |
| **Python ≥ 3.9** | faster-whisper + OpenCV host | system `python3` (manual prereq if absent) |
| **faster-whisper** | Stage 1 | `pip install` into managed `.venv` |
| **opencv-python** + YuNet ONNX | Stage 3 | `pip install` into the same `.venv`; model downloaded by bootstrap |
| **Caption font** | Stage 5/6 | bundled in `assets/fonts/` (OFL) — zero system-font dependency |

### Bootstrap flow (first run, auto-triggered when `.shortstop-ready` is absent)

```
1. Node ≥ 20 check            → else print install command, abort.
2. npm install                → ffmpeg-static, ffprobe-static, execa, ajv.
3. Validate ffmpeg/ffprobe    → -version + filter availability probe.
4. Python ≥ 3.9 check         → else print install command, abort.
5. python -m venv .venv && pip install faster-whisper opencv-python
6. Download YuNet ONNX → models/ ; pre-download Whisper model (config size).
7. Run doctor.mjs             → all green?
8. Write .shortstop-ready     → records resolved binary paths + versions.
```

`doctor.mjs` is runnable on demand and prints an actionable report (what's missing + the exact fix command), never a stack trace.

### Linux failure points

| Likely failure | Mitigation |
|---|---|
| CTranslate2 / opencv wheel mismatch on non-x86_64 | pin versions with arm64 wheels; venv isolates; doctor reports the exact pip error + alternative |
| PATH-fallback ffmpeg missing libass/loudnorm | static binaries preferred; doctor probes filters explicitly |
| First-run model downloads look "hung" | bootstrap streams progress; playbook tells the user it's one-time |
| Host project CWD not writable / dirs missing | skill creates `input|output|reference|runs` on demand; clear error otherwise |

(Note what is *gone* vs v1: the entire headless-Chromium dependency class — previously the #1 install risk — was eliminated by the ffmpeg renderer decision.)

### Path & process hygiene
- All paths via `node:path`/`node:url`; workspace dirs resolved against the **host project CWD**, skill internals against the skill folder.
- **No shell string interpolation.** Every external process is array-spawned (`execa`); filenames with spaces/unicode are safe. Filtergraph escaping is centralized in `lib/ffmpeg.mjs`.
- Temp files in `os.tmpdir()`; durable artifacts only under `runs/`.

---

## 7. Implementation Phases

Each phase has a **binary** acceptance check and builds what the next consumes.

### Phase 0 — Skeleton & contracts
- Repo tree per §4; six `schemas/*.schema.json`; `lib/artifacts.mjs` (validated read/write); `config/default.config.json` + schema; `package.json` + `.nvmrc`; `tests/fixtures.mjs` generator.
- **Done when:** valid hand-written samples of all six artifacts round-trip through `artifacts.mjs`, malformed samples are rejected (test asserts both), and `fixtures.mjs` generates the §4.2 fixture set.

### Phase 1 — Bootstrap & doctor
- `bootstrap.mjs`, `doctor.mjs`, `lib/spawn.mjs`, `lib/ffmpeg.mjs`, `lib/venv.mjs`.
- **Done when:** on a clean Linux machine, bootstrap writes `.shortstop-ready` and `node scripts/doctor.mjs` exits 0 all-green.

### Phase 2 — Probe & normalize (Stage 0)
- `probe.mjs`, `lib/timecode.mjs`.
- **Done when:** NTSC fixture → `fps_num/fps_den == 30000/1001` exactly; VFR fixture → `vfr: true` + normalized CFR intermediate produced; rotated fixture → corrected `display_*` dims; 21-min fixture → rejected with the one-line message. (All asserted.)

### Phase 3 — Transcription (Stage 1)
- `transcribe.py` + venv bridge + shared-mixdown WAV extraction.
- **Done when:** speech fixture → schema-valid transcript, every segment has word timestamps within `[0, duration]`, planted words present.

### Phase 4 — Silence map (Stage 2)
- `silence.mjs` with astats calibration + silencedetect parse.
- **Done when:** fixture with two planted silences → both detected ±100 ms, sorted, non-overlapping; a +20 dB noisier variant of the same fixture → same two regions found (calibration works); music fixture → empty map + `calibrated: false` handled without crash.

### Phase 5 — EDL validation (Stage 4 guardrail)
- `prompts/cut_decisions.md`; `build_edl.mjs` (pad → snap-to-silence-midpoint → merge → no-straddle check → coverage).
- **Done when (deterministic, no LLM in the loop):** a **canned** draft-EDL fixture is padded/snapped to the known silence midpoints exactly; overlapping/mid-word/out-of-range drafts are rejected with machine-readable reasons. *(Separately, a non-gating eval script runs the real prompt against the filler fixture and reports whether the planted filler was removed — quality signal, not a test.)*

### Phase 6 — Subject track (Stage 3)
- `track.py` (YuNet, stickiness, dead-zone smoothing, fallback).
- **Done when:** the zoompan-face fixture → `coverage ≥ 0.9`, crop path follows the known drift within tolerance, and **max crop velocity is bounded** (smoothing works — asserted numerically); the testsrc2 fixture → `mode: "fallback"`.

### Phase 7 — Captions (Stage 5)
- `build_captions.mjs` + bundled font.
- **Done when:** for a 2-keep EDL fixture, every Dialogue time lies within the output duration, line grouping respects the §5.6 rules, and ffmpeg parses the `.ass` (dry-run burn on 1 s of black succeeds).

### Phase 8 — Render (Stage 6)
- `render.mjs`: pass A, pass B (sendcmd crop / blur-pad, captions burn, two-pass loudnorm + aresample), post-render assertions, incremental pass-B re-render.
- **Done when:** 2-segment EDL → playable mp4 at 1080×1920, fps == source rational, `duration == Σkeep ± 1 frame`, integrated loudness −14 ± 1 LUFS, true peak ≤ −1 dBTP, audio at source sample rate (all asserted via ffprobe/loudnorm-measure).

### Phase 9 — QA loop (Stage 7)
- `qa.mjs` signal extraction + reference-signal caching; `prompts/qa_gap_fix.md`; the playbook loop logic (§8) encoded in SKILL.md; deterministic remediation map.
- **Done when:** (a) empty `reference/` aborts at start with the add-a-reference message; (b) a deliberately broken candidate (forced black frames) produces a `hard` gap and the refuse-to-deliver path writes `QA_REPORT.md` with no mp4 in `output/`; (c) a forced-non-converging soft-gap fixture terminates within 5 fix attempts via the no-progress guard and delivers best-candidate + report. Never an unbounded loop (asserted).

### Phase 10 — Skill packaging
- `SKILL.md` playbook (full §4 annotation), workspace-dir creation, `--review-edl`, progress surfacing, run pruning, output naming.
- **Done when:** with the skill installed at `.claude/skills/shortstop/` in a scratch project, dropping a fixture and invoking the skill end-to-end produces `output/<stem>-<runid>.mp4` that passes QA, with all artifacts in `runs/<id>/`; a second run does not clobber the first.

### Phase 11 — Hardening & distribution
- Fresh-clone E2E on a clean Linux box/container; README quickstart; package the `skill/` folder as the release artifact.
- **Done when:** clean machine → install Node/Python → copy skill folder → bootstrap + E2E smoke green with no other manual steps.

---

## 8. QA Loop Design

**Purpose.** Catch what automated cutting breaks — clipped words, choppy pacing, audio jumps, render glitches, lost framing — and fix it within a bounded loop. Measurement is deterministic (`qa.mjs`); fix decisions are Claude's.

### Signals & gaps

| Signal | Measured how | Severity | Default tolerance |
|---|---|---|---|
| **Coverage / duration integrity** | candidate duration vs `Σ keep` | **hard** | ± 1 frame |
| **Loudness** | two-pass loudnorm measure: integrated LUFS | **hard** | −14 ± 2 LU |
| **Clipping** | true peak | **hard** | ≤ −1 dBTP |
| **Visual defects** | `blackdetect` + `freezedetect` over the candidate | **hard** | none allowed |
| **Shorts length** | absolute duration | soft | ≤ 180 s (warn above) |
| **Framing** | YuNet on candidate frames sampled at 1 fps: face center within `framing_tolerance` (15%) of crop center for ≥ 90% of face-mode samples | soft | config |
| **Pacing / cut density** | cuts-per-minute + shot-length histogram from EDL vs **reference-derived** band | soft (advisory — never fix-driving on its own) | ± 50% |
| **Captions sanity** | `.ass` events count > 0 when enabled; last event ≤ duration | **hard** | — |
| **Content survival** | **by construction**: `build_edl.mjs` no-straddle check + the hard duration gate above. Optional `qa.verify_transcript: true` re-transcribes the candidate and fuzzy-matches kept words — **advisory only** (Whisper nondeterminism makes it unreliable as a gate), default off. | soft | — |

Changes vs v1, deliberately: **duration is never compared to the reference** (edit length is a property of the raw content — comparing to an unrelated clip forced content-butchering); SSIM-at-junctions is dropped (false-positives on natural motion — `freezedetect`/`blackdetect` cover the real defects); content survival moved from a flaky re-transcription gate to a structural guarantee.

### Fix-and-recheck cycle (executed by Claude per the playbook)

```
render candidate_a0 ; report_a0 = qa.measure()
best = (a0)                                  # best = highest score, fewest hard gaps
for attempt in 1 .. max_fix_attempts (5):
    if best has verdict "pass": break
    gaps = best.gaps ordered hard-first, largest deviation first
    fix = deterministic_remediation(gaps[0]) # loudness off → recompute loudnorm;
                                             # captions overflow → re-group lines;
                                             # framing lag → retune smoothing params
          else Claude applies prompts/qa_gap_fix.md
               → minimal EDL/param change targeting gaps[0] only
    re-render (pass B only if EDL unchanged) ; measure
    if score did not improve vs best: no_progress += 1
        if no_progress == 2: break           # score-based guard (EDL equality is
                                             # not the guard — LLM output varies)
    else: best = this attempt ; no_progress = 0

deliver:
    no gaps                → output/<stem>-<runid>.mp4
    soft gaps only         → deliver best + output/<stem>-<runid>.QA_REPORT.md
    any hard gap remaining → REFUSE: QA_REPORT.md only (observed vs target,
                             suggested manual fix, path to best candidate in runs/)
```

Loop invariants (fixing v1's mechanical bugs):
- **Measure-first ordering** — every Claude fix is rendered and measured; no fix is ever produced and then discarded at the ceiling.
- **Ceiling semantics** — `max_fix_attempts = 5` counts *fix* attempts; total renders ≤ 6 (initial + 5). With the ffmpeg renderer and pass-B-only re-renders, worst case stays in the minutes envelope.
- **Soft gaps get fix attempts** (while budget remains) but never block delivery at the ceiling.
- **Hard gaps never ship.** If the minimal-cut direction can't clear a hard gap, Shortstop refuses and reports rather than delivering a broken clip.
- **Deterministic remediations before LLM judgment** — gaps with a known mechanical fix (loudness, caption layout) never burn a judgment step.

---

## 9. Risks & Mitigations

| Risk | L | I | Mitigation |
|---|---|---|---|
| **Whisper word-timestamp slop** → clipped syllables | High | High | `pad_s` boundary padding + snap to silence **midpoints** in `build_edl.mjs` (the single snapping authority); VAD filter; QA framing/audio gates. |
| **Whisper mis-transcription** → wrong cut targets | Med | High | word `prob` surfaced to Stage 4; low-confidence words kept by rule; model size configurable. |
| **Over-aggressive cuts** | Med | High | "when unsure, keep it" bias; no cutting for length without a target; coverage stats in EDL; pacing advisory. |
| **VFR / rotated input breaks frame math** | High | High | Stage 0 detects and normalizes to CFR / bakes rotation **before** any timestamp is recorded. |
| **Tracking failures** (wrong face, jitter, no face) | Med | Med | largest-face + stickiness; dead-zone smoothing with bounded velocity (tested numerically); coverage-based blur-pad fallback; QA framing check on the *rendered* candidate. |
| **Crop upscale softness on 1080p sources** | High | Low | lanczos; README recommends ≥1440p capture; accepted v1 trade-off. |
| **Caption rendering issues** (font, escaping) | Low | Med | bundled font via `fontsdir` (no system fonts); centralized filtergraph escaping; Phase 7 dry-run parse test. |
| **Silence threshold mismatch** | Low | Med | auto-calibration from measured noise floor (Decision Record #8); recorded calibration values; explicit degraded mode when no silence exists. |
| **QA non-convergence / oscillation** | Med | Med | 5-attempt ceiling; score-based no-progress guard; best-candidate tracking; deliver-or-report fallback. |
| **Claude EDL nondeterminism** | Med | Med | validity is deterministic (`build_edl.mjs`); tests assert structural invariants, never exact cuts; LLM-dependent checks are non-gating evals. |
| **Linux dep breakage** (wheels, PATH ffmpeg) | Med | Med | static ffmpeg binaries; pinned versioned venv; doctor with exact fix commands; Phase 11 clean-machine verification. |
| **Disk growth** (multi-attempt 1080p candidates) | Med | Low | per-attempt files named `candidate_a<N>.mp4`; `runs.keep_last` pruning after delivery. |

---

## 10. Decision Record

All v1 open questions are resolved. The "why" is recorded so future contributors don't relitigate.

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Render engine | **ffmpeg only** | v1 needs cuts/concat/captions/loudnorm — all one ffmpeg pass-pair. Removes the Chromium install-risk class, the Remotion company-license issue, CPU-render slowness, and the float-fps mismatch with the exact-rational-fps requirement. EDL contract stays renderer-agnostic for a v2 Remotion swap (animated caption layouts). |
| 2 | Captions | **v1, on by default** | Word timestamps already exist; captions are table stakes for professional Shorts. ASS karaoke via libass — no extra renderer. |
| 3 | Aspect | **9:16 with subject tracking in v1** | A 16:9 file is not a Short. User explicitly chose tracked reframing over static crop — adds Stage 3 (YuNet) and the sendcmd crop path. Static modes remain as config fallbacks. |
| 4 | Reference clip | **Required** | User keeps the style-exemplar contract: abort at invocation start if `reference/` is empty. Fixed vs v1: reference drives **soft style tolerances only** — never duration. |
| 5 | QA ceiling | **5 fix attempts** | User chose a higher ceiling for quality. Affordable because the renderer is ffmpeg and audio/caption-only fixes re-run pass B alone. |
| 6 | Input length | **~20 min hard cap** | Rejects longer input with a clear message. Guarantees single-window Stage 4; deletes all chunking machinery from v1. |
| 7 | Whisper | **Local only** | No API key, no privacy surface, no network dependency. Weak machines drop to the `base` model. |
| 8 | Silence threshold | **Auto-calibrate** | Per-clip noise-floor measurement; fixed default only as fallback. Robust across rooms/mics without support burden. |
| 9 | Interactivity | **Fully hands-off** + `--review-edl` opt-in | Preserves the one-command promise; reviewers get the cut table on request. |
| 10 | Packaging | **Skill folder** at `.claude/skills/shortstop/` | Root-level SKILL.md / bundled commands are not discovered by Claude Code. Workspace dirs resolve against the host project CWD. No separate slash-command file. |
| 11 | Output naming | **Never clobber** — `output/<stem>-<runid>.mp4` | Re-edits never destroy prior versions. |
| 12 | Pre-transcode | **Only when probe detects trouble** (VFR / rotation / exotic codec) | Fast path for clean sources; the normalize machinery is mandatory anyway because VFR breaks the frame math. |
| — | Orchestration | **Claude orchestrates; scripts are tools** | A Node orchestrator cannot "call Claude" inside a skill without API keys/cost. Inverting control is what makes the skill work in-session. |
| — | Audio at junctions | **10 ms micro-fades**, not 40 ms cross-fades | Cross-fades require borrowing audio from removed regions (which may contain the cut filler) and break duration math. Cuts land in silence; micro-fades suffice. |
| — | Loudness | **Two-pass `loudnorm`** + `aresample` to source rate | Single-pass is dynamic (pumps); loudnorm upsamples to 192 kHz internally and must be resampled back. |
| — | Content survival | **Structural guarantee**, not re-transcription | `build_edl.mjs` no-straddle check + hard duration gate. Re-transcription is nondeterministic → advisory-only, off by default. |

---

## 11. Milestone Checklist

```
Phase 0 — Skeleton & contracts
- [ ] §4 tree; schemas/{probe,transcript,silence,track,edl,qa_report}.schema.json
- [ ] lib/artifacts.mjs validated read/write; default.config.json + schema
- [ ] tests/fixtures.mjs generates §4.2 fixture set
- [ ] DONE: valid samples pass, malformed fail; fixtures build

Phase 1 — Bootstrap & doctor
- [ ] bootstrap.mjs (npm deps, venv: faster-whisper+opencv, YuNet+Whisper model fetch)
- [ ] doctor.mjs actionable report; lib/{spawn,ffmpeg,venv}.mjs
- [ ] DONE: clean Linux → .shortstop-ready; doctor exits 0

Phase 2 — Probe & normalize
- [ ] probe.mjs (rational fps, rotation-corrected dims, VFR detect, audio-source resolve,
      20-min cap) + conditional CFR normalize; lib/timecode.mjs
- [ ] DONE: NTSC exact; VFR normalized; rotation corrected; 21-min rejected

Phase 3 — Transcription
- [ ] transcribe.py (word_timestamps, VAD) + shared-mixdown WAV extraction
- [ ] DONE: fixture → schema-valid word-level transcript in range

Phase 4 — Silence map
- [ ] silence.mjs (astats noise-floor calibration → silencedetect)
- [ ] DONE: planted silences ±100ms; noisy variant also passes; music → graceful empty map

Phase 5 — EDL validation
- [ ] prompts/cut_decisions.md; build_edl.mjs (pad → silence-midpoint snap → merge →
      no-straddle → coverage; machine-readable rejections)
- [ ] DONE: canned drafts snapped exactly / rejected correctly (no LLM in tests);
      separate non-gating prompt eval

Phase 6 — Subject track
- [ ] track.py (YuNet @5fps, largest+sticky, interpolate/hold, dead-zone smoothing,
      even-pixel clamp, fallback flag)
- [ ] DONE: face fixture coverage ≥0.9 + bounded crop velocity; no-face → fallback

Phase 7 — Captions
- [ ] build_captions.mjs (source→output time map, line grouping, ASS karaoke, bundled font)
- [ ] DONE: times in range; grouping rules hold; ffmpeg parses .ass

Phase 8 — Render
- [ ] render.mjs pass A (trim/concat/micro-fades → MKV+PCM mezzanine)
- [ ] render.mjs pass B (sendcmd crop | blur-pad, scale lanczos, subtitles burn,
      2-pass loudnorm + aresample, faststart) + post-render assertions + pass-B-only rerender
- [ ] DONE: 1080×1920, fps==source, dur==Σkeep ±1f, −14±1 LUFS, ≤−1 dBTP

Phase 9 — QA loop
- [ ] reference-required guard at invocation start; reference signal cache
- [ ] qa.mjs (coverage, loudness, peak, black/freeze, framing re-detect, pacing-advisory,
      captions sanity); prompts/qa_gap_fix.md; deterministic remediation map
- [ ] SKILL.md loop: measure-first, 5-attempt ceiling, score-based no-progress guard,
      best-candidate, soft-deliver / hard-refuse rules
- [ ] DONE: no-reference aborts; hard gap → refuse+report; non-converging soft → terminates ≤5

Phase 10 — Skill packaging
- [ ] SKILL.md playbook (bootstrap trigger, prereq checks, stage sequence, --review-edl,
      progress, delivery summary, runs pruning); workspace dir creation
- [ ] DONE: installed in scratch project → e2e green; second run never clobbers

Phase 11 — Hardening & distribution
- [ ] clean-machine E2E; README quickstart; package skill/ as release artifact
- [ ] DONE: fresh box + Node/Python → copy folder → bootstrap + smoke green
```
