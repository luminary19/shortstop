# Session Summary — 2026-06-10 14:10

## Current task
Full implementation of PLAN.md v2 (Shortstop — Claude Code skill turning a raw clip into a 9:16 captioned Short). **All 11 phases are complete, tested, and committed.** No work is in flight; the session ended with a clean working tree at commit `f66454d`.

## Status
- Completed this session:
  - Phase 0: 6 artifact schemas + config schema, `skill/scripts/lib/artifacts.mjs` (Ajv + semantic invariants + config merge), `tests/fixtures.mjs` deterministic fixture generator (espeak-ng + ffmpeg, ground-truth manifest), bundled Montserrat Bold as `skill/assets/fonts/CaptionFont.ttf`
  - Phase 1: `bootstrap.mjs` (dep-free until npm install), `doctor.mjs`, `lib/{spawn,ffmpeg,venv}.mjs`; venv at `skill/.venv` with faster-whisper 1.2.1 + opencv-python-headless; YuNet + whisper "small" models in `skill/models/`
  - Phase 2: `probe.mjs` + `lib/timecode.mjs` (rational fps, VFR→CFR normalize to `normalized.mkv`, rotation bake, 20-min cap)
  - Phase 3: `transcribe.py` + `transcribe.mjs` bridge (shared mixdown WAV)
  - Phase 4: `silence.mjs` (peak-level window calibration — silencedetect compares peaks not RMS)
  - Phase 5: `build_edl.mjs` (pad → directional expansion-only silence snap → merge → no-straddle → stats; machine-readable rejections) + `prompts/cut_decisions.md`
  - Phase 6: `track.py`/`track.mjs` (YuNet @5fps, sticky largest face, dead-zone + critically-damped spring, velocity clamp, blur-pad fallback)
  - Phase 7: `build_captions.mjs` (source→output word map, line grouping, karaoke \k ASS)
  - Phase 8: `render.mjs` (pass A trim/micro-fade/concat MKV+PCM mezzanine; pass B sendcmd dynamic crop / blur-pad, lanczos, caption burn, two-pass linear loudnorm + TP-deficit makeup via alimiter + 0.5 dB AAC headroom; post-render assertions; pass-B-only rerender via EDL keep-hash)
  - Phase 9: `qa.mjs` (duration/loudness/peak/black/freeze/framing/pacing/captions; reference cache in `reference/.shortstop-cache/`), `lib/qaloop.mjs` (bounded loop invariants), `deliver.mjs` (soft-deliver/hard-refuse, QA_REPORT.md, no-clobber, runs pruning), `prompts/qa_gap_fix.md`
  - Phase 10: `skill/SKILL.md` playbook; e2e test (two runs, no clobber); skill symlinked at `.claude/skills/shortstop` (discovered as /shortstop); README quickstart
  - Phase 11: `scripts/package.mjs` (tarball in `dist/`), `tests/clean-install-e2e.mjs` (bare-copy bootstrap → full pipeline → PASS)
  - Test results: `npm test` 51/51 pass; clean-install E2E PASS
- In progress: nothing
- Pending / next steps (optional follow-ups, not started):
  1. Live judgment-path validation: invoke `/shortstop` on `tests/fixtures/speech.mp4` so Claude actually performs Stage 4 + QA loop (the only untested-by-automation paths, by design); record results per `tests/eval_cut_prompt.md`
  2. True container-isolated clean-machine check (no Docker/Podman on this VPS — Phase 11 used a temp-dir simulation)
  3. Optional: CI workflow under `.github/`

## Files touched
- `skill/SKILL.md`, `skill/package.json`, `skill/.nvmrc`
- `skill/schemas/{probe,transcript,silence,track,edl,qa_report}.schema.json`
- `skill/config/{default.config.json,config.schema.json}`
- `skill/scripts/{bootstrap,doctor,probe,transcribe,silence,track,build_edl,build_captions,render,qa,deliver}.mjs`, `skill/scripts/{transcribe,track}.py`
- `skill/scripts/lib/{artifacts,spawn,ffmpeg,venv,timecode,qaloop}.mjs`
- `skill/prompts/{cut_decisions,qa_gap_fix}.md`
- `skill/assets/fonts/{CaptionFont.ttf,OFL.txt}`
- `tests/{fixtures.mjs,artifacts,probe,transcribe,silence,build_edl,track,captions,render,qa,e2e}.test.mjs`, `tests/clean-install-e2e.mjs`, `tests/eval_cut_prompt.md`
- `package.json` (root dev workspace; test glob `'tests/*.test.mjs'`), `README.md`, `.gitignore`, `scripts/package.mjs`
- Symlink `.claude/skills/shortstop` → `skill/`

## Key decisions
- **ffmpeg-static 7.0.2 segfaults on mpegts demux** on this VPS → fixtures use .mp4 segments; `lib/ffmpeg.mjs` validates binaries with a real encode smoke test and falls back to PATH ffmpeg
- **opencv-python-headless** instead of opencv-python (no libGL on servers)
- **Silence calibration uses window Peak_level, not RMS** — silencedetect thresholds compare sample peaks; RMS floors detect nothing on noisy audio
- **EDL snapping deviates from plan's literal "midpoint"**: directional, expansion-only, `min(midpoint, silence_start+0.25s)` capped at 1s — literal midpoint collapses long-pause removals to zero (documented in build_edl.mjs)
- **Loudness**: linear loudnorm undershoots when TP-capped → predicted-deficit makeup volume + alimiter; **0.5 dB headroom below TP target** because AAC encoding overshoots PCM peaks (~0.3 dB, caught by QA in e2e)
- **bootstrap.mjs must stay import-free of npm deps** until after its own `npm install` step (clean-machine crash otherwise)
- `node --test tests/` (bare dir) fails on Node 24 — npm test uses a quoted glob
- Normalized intermediate is `.mkv` (any source audio codec stream-copies)
- freezedetect runs only in face mode (screen recordings are legitimately static)

## Open questions / blockers
- None blocking. No container runtime on this VPS if a true clean-machine check is wanted.
- HF model downloads are unauthenticated (rate-limit warnings); setting HF_TOKEN would speed bootstrap.

## Next concrete step
Invoke `/shortstop` on a real clip (or `tests/fixtures/speech.mp4` copied to `input/`, with `tests/fixtures/reference.mp4` in `reference/`) to exercise the live Claude judgment paths end-to-end.
