# Shortstop — Implementation Plan

> A Claude Code skill that turns a raw recording into a ready-to-post short-form video, hands-off.
> Drop a clip in a folder, run `/editor`, get a polished `.mp4` back a couple minutes later.

This is a **build-from-scratch roadmap**. It is greenfield: the repo currently contains only `README.md`. Every recommendation below is opinionated and decisive; where a real trade-off exists, the pick and its one-line reason are stated inline and the alternative is logged in [Open Questions](#10-open-questions). Inline **Assumption:** markers flag gaps filled by judgment that the author should review.

---

## 1. Overview

**Problem.** Editing short-form video by hand is slow and repetitive: transcribe, find the dead air, cut filler and retakes, top-and-tail, render at the right fps, eyeball it against the look you want, fix the rough cuts, export. For a talking-head or screen-recording creator this is 30–90 minutes of mechanical work per clip that follows the same rules every time.

**Goal.** Automate the entire mechanical loop inside Claude Code. The user drops a raw clip into `input/`, runs `/editor`, and a few minutes later a polished, ready-to-post `.mp4` lands in `output/`. Claude orchestrates a deterministic pipeline (Whisper → silence-detect → cut-decision → Remotion render → QA loop) and only uses its own judgment where judgment is actually needed: deciding *what to cut* and *whether the result is good enough*.

**Definition of done (a successful delivered `.mp4`).** A delivered clip:
1. Is a valid, playable H.264/AAC `.mp4` at the **source clip's native fps and resolution** (no resample, no letterbox unless the reference demands it).
2. Has dead air, filler words, false starts, and abandoned retakes removed, with cuts landing on clean word/silence boundaries (no clipped syllables).
3. Has normalized, click-free audio (no hard cuts mid-word, no level jumps at edit points).
4. Passes the [QA loop](#8-qa-loop-design) against the reference clip within the retry ceiling, OR is delivered with an explicit `QA_REPORT.md` flagging the unresolved gap when QA cannot converge.
5. Is reproducible: re-running on the same input with the same config yields the same EDL and the same output (Claude cut decisions are the one non-deterministic step — see [Risks](#9-risks--mitigations)).

**Non-goal of this document.** This plan does not write the skill. It is the spec a competent developer (or Claude itself, in a later session) executes phase by phase.

---

## 2. Goals & Non-Goals

### Goals
- **One-command operation.** `/editor` (or a natural-language ask) on a dropped clip produces a finished `.mp4` with zero further input.
- **Hands-off cut decisions.** Filler, long pauses, false starts, and abandoned retakes are removed automatically based on transcript + silence analysis.
- **Source-faithful render.** Output preserves source fps, resolution, and audio characteristics exactly unless the reference clip dictates otherwise.
- **Self-configuring distribution.** The skill ships as a downloadable folder that drops into a Claude Code project and bootstraps its own dependencies on first run.
- **Linux-native.** Targets Linux only for now — one toolchain, no cross-OS abstraction layer.
- **Bounded, self-correcting QA.** Output is compared to a reference clip; defects are auto-fixed within a retry ceiling; failure is reported, never silently shipped.
- **Inspectable intermediates.** Every stage writes a durable artifact (transcript, silence map, EDL, render, QA verdict) so any run can be debugged or resumed.

### Non-Goals
- **No content generation.** Shortstop edits what was recorded; it does not write scripts, generate B-roll, add stock footage, or invent narration.
- **No captions/subtitles by default.** Burned-in captions are a likely *next* feature but are **out of scope for v1** (logged in Open Questions — the transcript needed already exists, so this is cheap to add later).
- **No music, transitions, or motion graphics by default.** v1 cuts and renders the existing footage. Stylistic overlays come from the reference-matching layer only if the reference itself implies them, and even then only simple ones (see Open Questions).
- **No multi-clip assembly.** v1 processes one raw clip → one short. Stitching multiple takes into one video is out of scope.
- **No upload/posting.** Shortstop produces a file. It does not post to TikTok/Reels/Shorts.
- **No cloud transcription/render by default.** Everything runs locally (privacy + no API cost for the heavy steps). Cloud Whisper is an Open Question fallback for low-power machines.
- **No cross-platform support in v1.** Linux only. macOS/Windows are explicitly out of scope; no effort is spent abstracting OS differences.
- **No GPU requirement.** Must run on a CPU-only machine; GPU is an optimization, not a dependency.
- **No real-time / streaming.** Batch processing of recorded files only.

---

## 3. Architecture

### Pipeline (stage diagram)

```
                            ┌──────────────────────────────────────────────┐
   input/raw.mp4  ───────▶  │  STAGE 0 — PROBE                              │
   (user drop)              │  ffprobe → source fps, resolution,           │
                            │  duration, audio codec/sample rate           │
                            └───────────────┬──────────────────────────────┘
                                            │ probe.json
                                            ▼
                            ┌──────────────────────────────────────────────┐
                            │  STAGE 1 — TRANSCRIBE                         │
                            │  faster-whisper → word-level timestamps      │
                            └───────────────┬──────────────────────────────┘
                                            │ transcript.json
                                            ▼
                            ┌──────────────────────────────────────────────┐
                            │  STAGE 2 — SILENCE MAP                        │
                            │  ffmpeg silencedetect → [start,end] dead air │
                            └───────────────┬──────────────────────────────┘
                                            │ silence.json
                                            ▼
                            ┌──────────────────────────────────────────────┐
                            │  STAGE 3 — CUT DECISIONS (Claude)            │
                            │  transcript + silence → reason about         │
                            │  filler / pauses / retakes → EDL             │
                            └───────────────┬──────────────────────────────┘
                                            │ edl.json   (keep-segments)
                                            ▼
                            ┌──────────────────────────────────────────────┐
                            │  STAGE 4 — RENDER (Remotion)                 │
                            │  build timeline from EDL, render at          │
                            │  SOURCE fps + resolution, mux normalized     │
                            │  audio                                       │
                            └───────────────┬──────────────────────────────┘
                                            │ candidate.mp4
                                            ▼
              ┌──────────────▶ ┌──────────────────────────────────────────┐
              │   fix loop     │  STAGE 5 — QA (compare vs reference)     │
              │  (≤ N retries) │  duration · pacing · audio · cut density │
              │                │  · visual diff  →  PASS / GAP list       │
              │                └───────────────┬──────────────────────────┘
              │                                │ qa_report.json
              │         GAP (adjust EDL/params)│ PASS
              └────────────────────────────────┤
                                               ▼
                            ┌──────────────────────────────────────────────┐
                            │  DELIVER → output/<name>.mp4                  │
                            │  (+ QA_REPORT.md if unconverged)             │
                            └──────────────────────────────────────────────┘
```

### Data-flow & artifact contracts

Every stage reads the previous artifact and writes its own into `runs/<run-id>/`. The run directory is the durable record; `output/` only ever receives the final `.mp4` (plus a report on failure).

| # | Artifact | Producer | Consumer(s) | Format | Contract (key fields) |
|---|----------|----------|-------------|--------|-----------------------|
| 0 | `probe.json` | Stage 0 (ffprobe) | 4, 5 | JSON | `{ fps_num, fps_den, fps, width, height, duration_s, audio_codec, sample_rate, channels, has_audio }` — fps stored as a **rational** (num/den) to preserve exact NTSC rates like 30000/1001. |
| 1 | `transcript.json` | Stage 1 (Whisper) | 3, 5 | JSON | `{ language, duration_s, segments: [{ id, start, end, text, words: [{ word, start, end, prob }] }] }` — **word-level** timestamps mandatory; `prob` is confidence. |
| 2 | `silence.json` | Stage 2 (ffmpeg) | 3, 4 | JSON | `{ threshold_db, min_silence_s, regions: [{ start, end, dur }] }` — sorted, non-overlapping, in source-time seconds. |
| 3 | `edl.json` | Stage 3 (Claude) | 4, 5 | JSON | **Keep-list, not cut-list.** `{ source: "input/raw.mp4", keep: [{ start, end, reason }], removed: [{ start, end, kind, reason }], target_fps: "<rational>", notes }`. `keep` segments are sorted, non-overlapping, snapped to word/silence boundaries. Audio cross-fade hint per junction. |
| 4 | `candidate.mp4` | Stage 4 (Remotion) | 5 | MP4 (H.264/AAC) | Rendered at `probe.fps`, `probe.width×height`; concatenation of `edl.keep` with short audio cross-fades at junctions; normalized loudness. |
| 5 | `qa_report.json` | Stage 5 (QA) | deliver / fix loop | JSON | `{ verdict: "pass"\|"gap", attempt, scores: {...}, gaps: [{ signal, observed, target, severity, suggested_fix }], reference: "reference/ref.mp4" }` |
| — | `output/<name>.mp4` | Deliver | user | MP4 | Final artifact. Byte-for-byte = the passing `candidate.mp4`. |
| — | `QA_REPORT.md` | Deliver (failure only) | user | Markdown | Human-readable explanation when QA cannot converge within the ceiling. |

**Design rule — keep-list over cut-list.** The EDL stores the segments to *keep*, not to remove. This makes Stage 4 a pure concatenation (no gap arithmetic) and makes "did we accidentally drop content?" a trivial coverage check (sum of keep durations vs. expected).

**Design rule — source-time everywhere.** All timestamps in artifacts 1–3 are in **source seconds** (floats). Frame conversion happens once, inside Stage 4, using the exact rational fps from `probe.json`. Nothing upstream ever reasons in frames.

---

## 4. Repository / Folder Layout

```
shortstop/
├── README.md                      # Quickstart: drop clip → /editor → done
├── PLAN.md                        # This file
├── SKILL.md                       # Claude Code skill manifest (name, description, when-to-use)
│
├── .claude/
│   └── commands/
│       └── editor.md              # /editor slash command → drives the pipeline orchestrator
│
├── input/                         # User drops raw clips here (watched dir)
│   └── .gitkeep
├── output/                        # Finished .mp4s delivered here
│   └── .gitkeep
├── reference/                     # User's style/pacing target clip(s) for QA
│   └── .gitkeep
├── runs/                          # Per-run intermediate artifacts (probe/transcript/silence/edl/qa)
│   └── .gitkeep                   #   runs/<run-id>/{probe,transcript,silence,edl,qa_report}.json + candidate.mp4
│
├── config/
│   ├── shortstop.config.json      # User-tunable defaults (silence thresh, fillers, QA tolerances, model size)
│   └── shortstop.config.schema.json  # JSON Schema validating the above; bootstrap checks against it
│
├── scripts/                       # Deterministic, language-agnostic pipeline stages (Node + Python)
│   ├── bootstrap.mjs              # First-run self-setup: detect/install ffmpeg, Whisper, Node deps; write .shortstop-ready
│   ├── doctor.mjs                 # `shortstop doctor` — checks all deps, prints actionable fixes
│   ├── probe.mjs                  # Stage 0 — ffprobe → probe.json
│   ├── transcribe.py             # Stage 1 — faster-whisper → transcript.json
│   ├── silence.mjs                # Stage 2 — ffmpeg silencedetect → silence.json
│   ├── build_edl.mjs              # Stage 3 helper — assembles Claude's decision into validated edl.json
│   ├── render.mjs                 # Stage 4 — invokes Remotion CLI with EDL + probe → candidate.mp4
│   ├── qa.mjs                     # Stage 5 — compares candidate vs reference → qa_report.json
│   ├── orchestrate.mjs            # Top-level driver: runs stages 0→5, owns the fix loop, calls Claude for stage 3
│   └── lib/
│       ├── platform.mjs           # Path resolution + shell-safe array-spawn wrapper (Linux)
│       ├── ffmpeg.mjs             # Locate/validate ffmpeg & ffprobe; wrap invocations
│       ├── whisper.mjs            # Locate Python + faster-whisper; wrap invocation
│       ├── timecode.mjs           # Rational fps ↔ frame ↔ source-seconds conversions (single source of truth)
│       └── artifacts.mjs          # Read/write/validate every artifact against its JSON Schema
│
├── remotion/                      # Remotion project (Stage 4 render engine)
│   ├── package.json
│   ├── remotion.config.ts
│   ├── src/
│   │   ├── index.ts               # registerRoot
│   │   ├── Root.tsx               # Composition registration; dimensions/fps from CLI props
│   │   ├── ShortstopVideo.tsx     # Timeline: <OffthreadVideo> per keep-segment, audio cross-fades
│   │   └── schema.ts              # Zod schema for input props (edl, probe) — Remotion calculateMetadata
│   └── tsconfig.json
│
├── schemas/                       # JSON Schemas for every inter-stage artifact (the contracts in §3)
│   ├── probe.schema.json
│   ├── transcript.schema.json
│   ├── silence.schema.json
│   ├── edl.schema.json
│   └── qa_report.schema.json
│
├── prompts/                       # Claude prompt templates (versioned, reviewable)
│   ├── cut_decisions.md           # Stage 3 prompt: transcript+silence → keep/remove EDL
│   └── qa_gap_fix.md              # Fix-loop prompt: qa gaps → adjusted EDL/params
│
├── tests/
│   ├── fixtures/                  # Tiny sample clips + golden artifacts for regression
│   └── *.test.mjs                 # Per-stage unit tests + one end-to-end smoke test
│
├── package.json                   # Node deps (orchestrator, Remotion), npm scripts (bootstrap, doctor, edit)
├── .nvmrc                         # Pin Node version for reproducibility
└── .shortstop-ready               # Written by bootstrap once setup succeeds (gitignored)
```

**Annotations for the load-bearing entries:**

- **`SKILL.md`** — the manifest Claude Code reads to know the skill exists and when to use it ("edit a raw video", "make a short", "polish this clip"). Points at `/editor`.
- **`.claude/commands/editor.md`** — defines the `/editor` slash command. Its body instructs Claude to run `scripts/orchestrate.mjs` against the newest file in `input/` (or a named file), surface progress, and handle the one interactive moment (Stage 3 cut reasoning).
- **`scripts/orchestrate.mjs`** — the spine. Pure stages run as subprocesses; the single AI step (Stage 3) and the fix loop are where Claude is invoked. Deterministic stages never call an LLM.
- **`remotion/`** — a self-contained Remotion project. Driven entirely by CLI props (`edl.json` + `probe.json`); no hardcoded dimensions or fps.
- **`schemas/` + `lib/artifacts.mjs`** — the contracts in §3 made executable. Every artifact is validated on write and on read; a malformed EDL fails fast instead of producing a broken render.
- **`prompts/`** — Claude's two jobs (cut decisions, gap fixes) live as versioned prompt files, not inline strings, so they can be tuned and diffed.
- **`config/shortstop.config.json`** — the only thing a user edits to change behavior (how aggressive cuts are, which words count as filler, QA tolerances, Whisper model size).

---

## 5. Component Specs

### 5.1 Stage 0 — Probe

| | |
|---|---|
| **Responsibility** | Extract exact technical metadata from the raw clip so every downstream stage preserves it. |
| **Tool** | `ffprobe` (ships with ffmpeg). Chosen because it reports the **exact rational frame rate** (`r_frame_rate`), avoiding the 29.97-rounded-to-30 class of bug. |
| **Consumes** | `input/<raw>.{mp4,mov,mkv,webm}` |
| **Emits** | `runs/<id>/probe.json` (contract in §3) |
| **Key params** | `ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate,width,height -show_entries format=duration -of json` plus an audio-stream query for codec/sample-rate/channels. |
| **Claude?** | No. Pure deterministic. |
| **Notes** | Parse `r_frame_rate` as `num/den` and store both the rational and the float. **Assumption:** input is a single-video-stream file; multi-stream files use stream 0. Reject files with no video stream early with a clear error. |

### 5.2 Stage 1 — Transcription

| | |
|---|---|
| **Responsibility** | Produce a word-level, timestamped transcript that Stage 3 reasons over and Stage 5 uses to verify content survival. |
| **Tool** | **`faster-whisper`** (CTranslate2 reimplementation of OpenAI Whisper). Chosen over reference `openai-whisper` because it is **4–5× faster on CPU**, uses less RAM, runs CPU-only (no GPU dependency, per Non-Goals), and exposes word-level timestamps. Default model **`small`** (good accuracy/speed balance for clean talking-head audio); configurable to `base`/`medium`. |
| **Consumes** | `input/<raw>` (ffmpeg extracts a 16 kHz mono WAV internally first) |
| **Emits** | `runs/<id>/transcript.json` (contract in §3) with `word_timestamps=True` |
| **Key params** | `model_size` (config), `word_timestamps=True`, `vad_filter=True` (Silero VAD trims hallucinated text in silence), `language` (auto-detect, overridable), `beam_size=5`. |
| **Claude?** | No. Deterministic ML inference. |
| **Notes** | **Assumption:** primarily English/single-speaker talking-head or screen-rec narration. faster-whisper is a Python package → this is the one stage that requires a Python runtime (see §6). Word `prob` (confidence) is preserved and surfaced to Stage 3 so Claude can treat low-confidence regions cautiously. |

### 5.3 Stage 2 — Silence Map

| | |
|---|---|
| **Responsibility** | Find every region of dead air so Stage 3 can cut pauses and Stage 4 can snap cuts to silence (click-free edits). |
| **Tool** | `ffmpeg -af silencedetect`. Chosen because it is already a dependency, deterministic, and fast (single audio pass). |
| **Consumes** | `input/<raw>` audio |
| **Emits** | `runs/<id>/silence.json` (contract in §3) |
| **Key params** | `silencedetect=noise=<threshold_db>:d=<min_silence_s>` — defaults `noise=-30dB`, `d=0.6s` (config-tunable). Parse `silence_start`/`silence_end` lines from stderr into regions. |
| **Claude?** | No. |
| **Notes** | The silence map is advisory to Stage 3 (Claude decides *whether* a given pause is a real cut point or natural breath) and authoritative to Stage 4 (cuts snap to the nearest silence edge within a tolerance window to avoid clipping speech). |

### 5.4 Stage 3 — Cut Decisions (the AI step)

| | |
|---|---|
| **Responsibility** | Decide what to remove (filler words, long pauses, false starts, abandoned retakes, rambles) and emit a validated **keep-list EDL**. |
| **Tool** | **Claude**, invoked by the orchestrator with `prompts/cut_decisions.md`. This is the only stage where judgment beats rules — distinguishing "a deliberate dramatic pause" from "dead air," or "the second, better take" from "the first abandoned one," is exactly an LLM-shaped problem. |
| **Consumes** | `transcript.json` + `silence.json` + relevant `config` (filler list, aggressiveness, target duration if any) |
| **Emits** | Claude returns a structured keep/remove decision → `build_edl.mjs` validates, snaps boundaries to word/silence edges, and writes `runs/<id>/edl.json`. |
| **Claude invocation — the prompt MUST contain:** | 1. **Role**: senior short-form video editor. 2. **The transcript** with word-level timestamps and confidence. 3. **The silence map**. 4. **Explicit cut rules**: remove filler (`um, uh, like, you know, …` from config), pauses > `max_pause_s`, false starts (repeated/abandoned sentence stems), and clear retakes (keep the last clean attempt). 5. **Hard constraints**: output **keep-segments only**, sorted, non-overlapping, snapped to word boundaries; never cut mid-word; preserve meaning and natural cadence; do not remove content for length unless a target is set. 6. **Output contract**: strict JSON matching `edl.schema.json`, each removal tagged with `kind` + one-line `reason`. 7. **"Only cut what the rules justify. When unsure, keep it."** (bias against over-cutting — see Risks). |
| **Notes** | Claude returns *decisions*, never frame math. `build_edl.mjs` is the deterministic guardrail: it rejects overlapping/out-of-order/mid-word segments and recomputes a content-coverage figure. **Assumption:** transcripts fit in one context window for typical short-form raw clips (≤ ~20 min); longer clips are chunked by silence-bounded windows (logged in Open Questions). |

### 5.5 Stage 4 — Render

| | |
|---|---|
| **Responsibility** | Turn the keep-list EDL into a finished `.mp4` at the source's exact fps and resolution, with clean audio at every junction. |
| **Tool** | **Remotion** (React-based programmatic video). Chosen per the product spec; it gives deterministic, code-defined timelines and frame-exact control. fps and dimensions come from `probe.json` via `calculateMetadata`, never hardcoded. |
| **Consumes** | `edl.json` + `probe.json` + `input/<raw>` |
| **Emits** | `runs/<id>/candidate.mp4` |
| **How it works** | `Root.tsx` registers a composition whose `fps`/`width`/`height` are derived from `probe.json`. `ShortstopVideo.tsx` lays each `keep` segment as an `<OffthreadVideo>` with `startFrom`/`endAt` computed by `lib/timecode.mjs` from source-seconds × exact fps. Junctions get short (≈40 ms) audio cross-fades to kill clicks. Render via `npx remotion render` with `--props` carrying the EDL+probe, `--codec h264`. **Audio loudness normalization** (EBU R128, `loudnorm`) is applied as an ffmpeg post-pass on the muxed output (Remotion renders the cut; ffmpeg normalizes — simpler than doing loudness inside React). |
| **Key params** | fps = `probe.fps` (rational), resolution = source, `--codec h264`, CRF/quality from config, audio cross-fade duration, `loudnorm` target `-14 LUFS` (standard for social). |
| **Claude?** | No. |
| **Notes** | **fps preservation is non-negotiable** and is asserted post-render: `ffprobe` the candidate and fail the stage if its `r_frame_rate` ≠ source. **Assumption:** Remotion's `<OffthreadVideo>` handles the source codec; if a source needs transcoding to a Remotion-friendly intermediate, `render.mjs` does a lossless-ish pre-transcode first (decision logged in Open Questions). |

### 5.6 Stage 5 — QA Loop

| | |
|---|---|
| **Responsibility** | Compare the candidate to the reference clip, decide pass/gap, and drive auto-fixes until pass or the retry ceiling. |
| **Tool** | `qa.mjs` (deterministic signal extraction via ffmpeg/ffprobe) + **Claude** for the fix decision when gaps exist (`prompts/qa_gap_fix.md`). Split because *measuring* is deterministic but *deciding how to close a gap* (loosen silence threshold? re-snap a cut? the cut was too aggressive?) is judgment. |
| **Consumes** | `candidate.mp4` + `reference/<ref>.mp4` (**required** — no reference ⇒ pipeline aborts before render) + `transcript.json` (content-survival check) + `probe.json` |
| **Emits** | `runs/<id>/qa_report.json`; on gap, an adjusted `edl.json`/params for the next attempt. |
| **Signals** | duration ratio, pacing (cuts-per-minute / avg shot length), audio loudness & peak, cut density vs reference, coarse visual diff (see §8), content-survival (no kept words dropped). |
| **Claude invocation — the fix prompt MUST contain:** | the gap list with observed-vs-target numbers, the current EDL, and the instruction to propose the **minimal** EDL/param change that closes the largest gap without violating cut rules — returning a new EDL plus a one-line rationale. |
| **Claude?** | Measurement no; fix decision yes. |
| **Notes** | Full design in §8. The loop is **bounded** and always terminates with either a delivered file or a `QA_REPORT.md`. |

---

## 6. Environment & Setup (Linux)

Target: **Linux only** (v1). The orchestrator and all `.mjs` stages run on **Node**; the only non-Node dependency is **Python** for `faster-whisper`. ffmpeg/ffprobe are external native binaries. No OS-detection or cross-platform abstraction is built — code assumes a POSIX shell, `/`-separated paths, and a Linux dynamic loader.

### Dependencies & acquisition

| Dependency | Role | Acquisition (Linux) |
|---|---|---|
| **Node ≥ 20** (`.nvmrc`) | orchestrator + Remotion | distro package or nvm |
| **ffmpeg + ffprobe** | probe, silence, mux, loudnorm | `ffmpeg-static` / `ffprobe-static` npm packages (pinned, no system pkg-mgr) |
| **Python ≥ 3.9** | host for faster-whisper | system Python (`python3`) |
| **faster-whisper** | transcription | `pip install faster-whisper` into a managed `.venv` |
| **Remotion + Chromium** | render | `npm install` (Remotion fetches its own Chromium) + headless system libs |

**Pinned-binary strategy (decisive pick):** install ffmpeg/ffprobe via the **`ffmpeg-static` / `ffprobe-static` npm packages** so they arrive with `npm install` at a known version, with no `apt/dnf/pacman` step. Fall back to a system `ffmpeg` on PATH only if the static binary is missing for the arch. This removes the biggest install failure point.

### Path & process handling
- **All paths via `path` / `node:url`** and kept repo-relative under `runs/`; no manual separator handling needed (Linux only).
- **No shell string interpolation.** Every external process is spawned with `execa`/`spawn` using **argument arrays**, not a shell command string — injection-safe for filenames with spaces/unicode; quoting only at the ffmpeg-filtergraph layer where ffmpeg itself parses.
- **Temp files** via `os.tmpdir()`; durable artifacts always under repo `runs/`.

### Self-setup / bootstrap flow (first run)

`scripts/bootstrap.mjs`, triggered automatically by `/editor` if `.shortstop-ready` is absent:

```
1. Check Node ≥ 20           → else: print the install command, abort.
2. npm install               → orchestrator deps, Remotion, ffmpeg-static, ffprobe-static.
3. Locate ffmpeg/ffprobe     → prefer static pkg, else PATH; validate `-version`.
4. Check Python ≥ 3.9        → else: print the install command, abort with link.
5. Create managed venv (.venv) + `pip install faster-whisper`.
6. Pre-download Whisper model (config size) so first edit isn't blocked on a model fetch.
7. Remotion bundle warm-up   → ensure its Chromium + headless libs are present.
8. Run `doctor.mjs` self-check → all green?
9. Write `.shortstop-ready` (records resolved binary paths + versions).
```

`scripts/doctor.mjs` is also runnable on demand and prints an **actionable** report (what's missing + the exact command to fix it) rather than a stack trace.

### Linux failure points (called out)

| Likely failure | Mitigation |
|---|---|
| Remotion's headless Chromium missing shared libs (`libnss3`, `libatk`, etc.) | doctor checks for them and prints the distro install line. |
| System `ffmpeg` (if used as fallback) lacking `silencedetect`/`loudnorm` | static package avoids it; doctor validates filter availability with a probe call. |
| Python wheel / CTranslate2 arch mismatch on non-x86_64 (e.g. arm64 server) | pin a faster-whisper version with wheels for the arch; venv isolates it. |
| First-run model/Chromium downloads are slow → looks "hung" | bootstrap streams progress; `/editor` tells the user setup is a one-time cost. |

---

## 7. Implementation Phases

Phases are ordered so each is independently testable and builds the artifact the next consumes. Every phase has a **binary** acceptance check.

### Phase 0 — Repo skeleton & contracts
- **Objective:** lay the structure and the artifact schemas before any logic.
- **Tasks:** create the §4 tree (empty stubs + `.gitkeep`s); write the five `schemas/*.json`; implement `lib/artifacts.mjs` (schema-validated read/write); write `config/shortstop.config.json` + its schema; `package.json` + `.nvmrc`.
- **Delivers:** a validatable contract layer.
- **Done when:** `node -e` round-trips a hand-written sample of each artifact through `artifacts.mjs` and **schema validation passes for valid samples and fails for malformed ones** (a tiny test asserts both).

### Phase 1 — Bootstrap & doctor
- **Objective:** dependable one-command Linux setup before any media work.
- **Tasks:** implement `platform.mjs`, `bootstrap.mjs`, `doctor.mjs`; wire ffmpeg-static/ffprobe-static; venv + faster-whisper install; model pre-fetch; `.shortstop-ready`.
- **Delivers:** one-command environment setup.
- **Done when:** on a clean Linux machine, running bootstrap produces `.shortstop-ready` and **`node scripts/doctor.mjs` exits 0 with every dependency green**.

### Phase 2 — Probe (Stage 0)
- **Objective:** exact source metadata.
- **Tasks:** `probe.mjs` + `lib/ffmpeg.mjs`; `lib/timecode.mjs` rational fps handling.
- **Delivers:** `probe.json`.
- **Done when:** on a known 29.97 fps test clip, `probe.json.fps_num/fps_den == 30000/1001` and width/height/duration **match `ffprobe` ground truth exactly** (asserted in test).

### Phase 3 — Transcription (Stage 1)
- **Objective:** word-level transcript.
- **Tasks:** `transcribe.py` (faster-whisper, `word_timestamps=True`, VAD); `whisper.mjs` Node↔Python bridge; WAV extraction.
- **Delivers:** `transcript.json`.
- **Done when:** on a 30 s fixture clip, `transcript.json` validates against schema and **every segment has non-empty word-level timestamps within `[0, duration]`** (asserted).

### Phase 4 — Silence map (Stage 2)
- **Objective:** dead-air regions.
- **Tasks:** `silence.mjs`; parse `silencedetect` stderr; config thresholds.
- **Delivers:** `silence.json`.
- **Done when:** on a fixture with two known inserted silences, **both regions are detected within ±100 ms and regions are sorted/non-overlapping** (asserted).

### Phase 5 — Cut decisions (Stage 3, Claude)
- **Objective:** transcript + silence → validated keep-list EDL.
- **Tasks:** write `prompts/cut_decisions.md`; orchestrator Claude call; `build_edl.mjs` (validate, boundary-snap, coverage check).
- **Delivers:** `edl.json`.
- **Done when:** on a fixture with scripted filler + one false start, the produced `edl.json` **validates against schema, has zero overlapping/mid-word segments, and `removed` includes the planted filler** (asserted; boundary-snap and overlap checks are deterministic so the binary check does not depend on LLM nondeterminism).

### Phase 6 — Render (Stage 4, Remotion)
- **Objective:** EDL → candidate.mp4 at source fps/resolution.
- **Tasks:** Remotion project; `Root.tsx`/`ShortstopVideo.tsx` props-driven dimensions+fps; `render.mjs`; `loudnorm` post-pass; junction cross-fades; post-render fps assertion.
- **Delivers:** `candidate.mp4`.
- **Done when:** rendering a 2-segment EDL yields a playable mp4 whose **`ffprobe` fps == source fps, resolution == source, and duration == sum(keep durations) ±1 frame** (asserted).

### Phase 7 — QA loop (Stage 5)
- **Objective:** compare to reference, auto-fix, bound the loop.
- **Tasks:** **reference-required guard** (abort before render with a clear message if `reference/` is empty); `qa.mjs` signal extraction; `prompts/qa_gap_fix.md`; orchestrator fix loop with retry ceiling + convergence/fallback (§8).
- **Delivers:** `qa_report.json`, fix loop, `QA_REPORT.md` on failure.
- **Done when:** (a) running with an empty `reference/` **aborts before render with a clear "add a reference clip" message**, and (b) a deliberately bad candidate (e.g. 2× target duration) triggers ≥1 fix attempt and **the loop terminates within the ceiling with either a pass or a written `QA_REPORT.md` — never an infinite loop** (asserted with a forced-non-converging fixture).

### Phase 8 — Skill packaging & `/editor`
- **Objective:** wire the whole pipeline behind the skill UX.
- **Tasks:** `SKILL.md`; `.claude/commands/editor.md`; `orchestrate.mjs` end-to-end (input-watch → stages 0–7 → deliver); progress surfacing; natural-language entry.
- **Delivers:** the usable skill.
- **Done when:** dropping a fixture clip in `input/` and running `/editor` (or asking in NL) **produces an `output/<name>.mp4` that passes QA, with all run artifacts present in `runs/<id>/`** — full end-to-end smoke test green.

### Phase 9 — Hardening & distribution
- **Objective:** verified clean-clone install on Linux; shippable folder.
- **Tasks:** run E2E on a fresh Linux environment; fix path/shell/dep issues; finalize README quickstart; confirm clean-clone → bootstrap → edit works; package the downloadable folder.
- **Delivers:** the distributable skill.
- **Done when:** a **fresh clone on a clean Linux machine** completes bootstrap and the E2E smoke test with no manual intervention beyond installing Node/Python where the system lacks them.

---

## 8. QA Loop Design

**Purpose.** Catch the failure modes automated cutting introduces — over-aggressive trims, pacing that doesn't match the creator's style, audio jumps, clipped words — by measuring the candidate against a **reference clip** that represents the target look/feel, then fixing within a bounded loop.

### Signals (candidate vs reference)

| Signal | How measured | Why it matters |
|---|---|---|
| **Duration / coverage** | candidate duration; sum of kept transcript words vs source | catches over-cutting (too short / dropped content) and under-cutting (nothing removed). |
| **Pacing** | cuts-per-minute & average shot length (from EDL junctions) vs reference's | matches the creator's rhythm — a snappy reference implies tighter cuts. |
| **Audio loudness & peak** | `ffmpeg loudnorm`/`astats` integrated LUFS + true peak vs reference | ensures consistent, social-ready levels; flags clipping. |
| **Cut density distribution** | histogram of shot lengths vs reference | distinguishes "many tiny jump cuts" from "few long holds." |
| **Visual diff (coarse)** | perceptual hash / SSIM on sampled frames at cut boundaries; black-frame & freeze detection | catches render glitches, black frames, frozen junctions, letterboxing. |
| **Content survival** | every `edl.keep` word present in candidate transcript region (re-transcribe candidate or map by time) | guarantees no meaningful speech was lost. |

**Reference handling.** A reference clip in `reference/` is **required**; the orchestrator aborts before render if none is present (the user is told to add one). The reference's signals are computed once and cached. **Assumption:** the reference is a *style/pacing exemplar*, not a frame-by-frame template — QA matches **distributions and tolerances** derived from the reference, not exact timings. Config still supplies hard absolute bounds (loudness target, true-peak ceiling, no black/frozen frames, content-survival = 100%) that apply alongside the reference-derived tolerances.

### What counts as a "gap"

A gap is any signal outside its tolerance band (tolerances in `config`):

| Gap | Example condition | Default tolerance |
|---|---|---|
| too long / too short | `dur` outside reference ±25% (or target ±10% if set) | configurable |
| pacing mismatch | cuts/min off reference by > 50% | configurable |
| loudness off | integrated LUFS off target by > 2 LU | hard |
| clipping | true peak > -1 dBTP | hard |
| visual defect | any black/frozen frame, or SSIM < 0.4 across a non-cut junction | hard |
| content loss | any kept word missing from candidate | hard (never ship) |

Gaps carry a **severity**: `hard` gaps block delivery; `soft` gaps (pacing/duration within reason) are attempted but won't fail an otherwise-good clip at the ceiling.

### Fix-and-recheck cycle

```
attempt = 0
while attempt < CEILING:
    candidate = render(edl)
    report = qa.measure(candidate, reference)        # deterministic
    if report.verdict == "pass": deliver(candidate); return
    if no actionable hard gaps and only soft gaps remain: deliver(candidate); return
    edl = claude.fix(report.gaps, edl, rules)         # minimal change, largest gap first
    if edl == previous_edl: break                     # no-progress guard
    attempt += 1
deliver_with_report(best_candidate, QA_REPORT.md)     # fallback
```

- **Minimal-change principle:** each fix targets the single largest actionable gap (e.g. "duration 2× → restore the over-trimmed segments tagged low-confidence"), not a wholesale re-edit — keeps the loop convergent.
- **No-progress guard:** if a fix produces an EDL identical to the prior attempt (or scores don't improve), break immediately rather than burning the ceiling.

### Retry ceiling & non-convergence fallback

- **Ceiling: 3 fix attempts** (`config.qa.max_attempts`, default 3). Each attempt is one render + one measure; rendering is the expensive step, so 3 bounds wall-clock to "a couple minutes" for short clips. (Alternative ceilings logged in Open Questions.)
- **Best-candidate tracking:** the loop keeps the highest-scoring candidate seen.
- **Fallback when QA can't converge:** deliver the **best** candidate to `output/` **and** write `output/<name>.QA_REPORT.md` listing the unresolved gaps, observed-vs-target numbers, and a suggested manual fix. Hard `content-loss` gaps are the exception — if content was lost and can't be restored, the loop reverts toward a **less aggressive EDL** rather than shipping lossy; if even the minimal-cut EDL fails a hard visual/content check, Shortstop **refuses to deliver** and reports, rather than shipping a broken clip.

---

## 9. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Whisper accuracy** (mis-transcribed words → wrong cut points) | Medium | High | Word-level `prob` surfaced to Stage 3; Claude treats low-confidence regions cautiously and biases toward keeping. VAD filter reduces hallucinated text. Model size configurable up to `medium` for hard audio. |
| **Whisper latency** (slow on CPU / long clips) | Medium | Medium | `faster-whisper` (4–5× faster than reference). Default `small` model. Pre-download model in bootstrap. Chunk long clips. Cloud-Whisper fallback is an Open Question for weak machines. |
| **Over-aggressive / wrong cuts** (clips feel choppy or lose meaning) | Medium | High | "When unsure, keep it" prompt bias; boundary-snap to word edges (never mid-word); QA content-survival is a *hard* gap; fix loop restores over-trimmed segments; reference-pacing comparison catches choppiness. |
| **fps / resolution mismatch** (output resampled, stutters) | Low | High | Exact **rational** fps from `ffprobe`; props-driven Remotion composition; **post-render fps assertion fails the stage** if it drifts. Resolution carried from probe, never hardcoded. |
| **Remotion render failure** (codec, Chromium, OOM) | Medium | High | Optional lossless pre-transcode to a Remotion-friendly intermediate; Chromium fetched & validated in bootstrap; render runs in a subprocess with a timeout; clear error → doctor. |
| **Linux dependency/install breakage** (missing Chromium libs, Python/arch mismatch) | Medium | High | ffmpeg-static/ffprobe-static (no system pkg mgr); array-spawn (no shell quoting); managed Python venv; `doctor.mjs` with exact fix commands; Phase 9 verifies a fresh clean-clone install. |
| **QA loop non-convergence** (infinite/oscillating fixes) | Medium | Medium | Hard retry ceiling (3); no-progress guard; best-candidate tracking; deterministic fallback that always delivers-or-reports. |
| **Long clips / memory** (transcript > context, render OOM) | Medium | Medium | Silence-bounded chunking for transcription + Stage 3 windowing; streaming render where possible; **Assumption:** v1 optimized for ≤ ~20 min raw → short-form; longer is best-effort and logged. |
| **Claude nondeterminism in EDL** (different cuts run-to-run) | Medium | Medium | Deterministic guardrails (`build_edl.mjs`) make *validity* deterministic even if *choices* vary; low temperature for the cut prompt; tests assert structural invariants, not exact cuts. |
| **Silence threshold mismatch** (quiet rooms vs noisy) | Medium | Medium | Config-tunable `noise`/`d`; **Assumption:** -30 dB / 0.6 s default; doctor/first-run could calibrate from the clip's noise floor (Open Question). |

---

## 10. Open Questions

Each blocks or shapes a decision; phrased as concrete either/ors. **None currently block any phase — Phase 1 is unblocked.**

> **Resolved:** *Cross-platform support* — Linux only for v1 (macOS/Windows out of scope). *Reference clip* — **required**; the pipeline aborts before render if `reference/` is empty. *ffmpeg sourcing* — **`ffmpeg-static` / `ffprobe-static` npm packages** (system `ffmpeg` on PATH used only as an automatic fallback if the static binary is missing for the arch).

1. **Captions in v1?** Non-Goals excludes them, but the word-level transcript makes burned-in captions nearly free. Add a v1 toggle (off by default) or defer entirely? Shapes **Stage 4** scope.
2. **Whisper location:** fully local `faster-whisper` (plan's pick) vs offer a cloud Whisper fallback for low-power machines (adds an API key + privacy consideration). Affects **Phase 3** + Non-Goals.
3. **Long-clip handling:** confirm the **~20 min** raw-input ceiling for v1, or must it handle 60-min+ recordings (changes chunking design materially)? Shapes **Stage 1/3**.
4. **Remotion intermediate transcode:** always pre-transcode to a friendly intermediate (robust, slower) vs feed source directly to `<OffthreadVideo>` and transcode only on failure (faster, plan's pick)? Affects **Phase 6**.
5. **QA retry ceiling:** 3 attempts (plan's pick) vs a wall-clock budget (e.g. "stop after 3 min") vs user-configurable per run? Affects **Phase 7**.
6. **Aspect ratio:** deliver at source aspect untouched (plan's pick), or auto-reframe to vertical 9:16 for Shorts/Reels/TikTok (a much bigger feature — reframing/subject-tracking)? Currently a Non-Goal; confirm.
7. **Output naming & collisions:** `output/<sourcename>.mp4` overwrite vs timestamped/`-v2` suffix to avoid clobbering a prior edit? Minor; affects **Phase 8**.
8. **Silence-threshold calibration:** fixed config default (-30 dB) vs auto-calibrate per clip from its measured noise floor? Affects **Stage 2** robustness.
9. **`/editor` interactivity:** fully hands-off (plan's default), or pause to let the user approve the EDL before rendering on first use? Affects **Phase 8** UX.

---

## 11. Milestone Checklist

```
Phase 0 — Skeleton & contracts
- [ ] §4 folder tree created with stubs + .gitkeep
- [ ] schemas/{probe,transcript,silence,edl,qa_report}.schema.json written
- [ ] lib/artifacts.mjs validates read/write against schemas
- [ ] config/shortstop.config.json + schema
- [ ] package.json + .nvmrc
- [ ] DONE: valid samples pass, malformed samples fail (test)

Phase 1 — Bootstrap & doctor
- [ ] lib/platform.mjs (path resolution, array-spawn)
- [ ] bootstrap.mjs (node check, npm install, ffmpeg-static, venv + faster-whisper, model prefetch, Chromium warm-up)
- [ ] doctor.mjs (actionable Linux report)
- [ ] DONE: bootstrap writes .shortstop-ready; doctor exits 0 all-green on clean Linux

Phase 2 — Probe
- [ ] lib/ffmpeg.mjs + lib/timecode.mjs (rational fps)
- [ ] probe.mjs → probe.json
- [ ] DONE: 29.97 clip → fps 30000/1001, dims/duration exact

Phase 3 — Transcription
- [ ] transcribe.py (faster-whisper, word_timestamps, VAD)
- [ ] whisper.mjs bridge + WAV extraction
- [ ] DONE: fixture → transcript.json with word-level timestamps in range

Phase 4 — Silence map
- [ ] silence.mjs (silencedetect parse, config thresholds)
- [ ] DONE: two planted silences detected ±100ms, sorted/non-overlapping

Phase 5 — Cut decisions (Claude)
- [ ] prompts/cut_decisions.md
- [ ] orchestrator Claude call + build_edl.mjs (validate, boundary-snap, coverage)
- [ ] DONE: edl.json validates, no overlap/mid-word, planted filler removed

Phase 6 — Render (Remotion)
- [ ] remotion/ project, props-driven fps+dims
- [ ] render.mjs + loudnorm post-pass + junction cross-fades + fps assertion
- [ ] DONE: 2-segment EDL → playable mp4, fps==source, res==source, dur==Σkeep ±1 frame

Phase 7 — QA loop
- [ ] reference-required guard (abort before render if reference/ empty)
- [ ] qa.mjs signal extraction (duration, pacing, audio, cut density, visual diff, content survival)
- [ ] prompts/qa_gap_fix.md + fix loop (ceiling, no-progress guard, best-candidate, fallback)
- [ ] DONE: empty reference aborts clearly; bad candidate triggers ≥1 fix; loop always terminates (pass or QA_REPORT.md)

Phase 8 — Skill packaging & /editor
- [ ] SKILL.md + .claude/commands/editor.md
- [ ] orchestrate.mjs end-to-end + progress + NL entry
- [ ] DONE: drop clip + /editor → output/<name>.mp4 passes QA, runs/<id>/ artifacts present

Phase 9 — Hardening & distribution
- [ ] E2E on a clean Linux environment; path+shell+dep fixes
- [ ] README quickstart; downloadable folder packaged
- [ ] DONE: fresh clone on clean Linux → bootstrap + E2E smoke green, no manual steps beyond Node/Python
```
