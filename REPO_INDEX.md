# Repo index — shortstop
Auto-maintained by `/wrap` to depth 3. Runtime/generated subtrees are collapsed.

```
shortstop/                          # /shortstop Claude Code skill: raw clip → ready-to-post Shorts/longform
├── .claude/
│   ├── session_summary.md          # /wrap handoff note (latest session state)
│   └── skills/
│       └── shortstop -> ../../skill  # symlink so the skill is discoverable as /shortstop
├── .gitignore
├── NOTES.md                        # known limitations / scratch notes
├── PLAN.md                         # implementation plan v2 (all 11 phases done)
├── README.md                       # quickstart
├── package.json                    # root dev workspace (npm test glob, shortstop-skill link)
├── package-lock.json
├── input/                          # drop source clips here (gitignored content)
├── output/                         # delivered mp4s + QA_REPORT.md sidecars
├── reference/                      # style exemplar clip(s) required by QA (+ .shortstop-cache/)
├── runs/                           # per-run artifacts: probe/transcript/silence/track/ideas, clipN/ workspaces (pruned by deliver)
├── scripts/
│   └── package.mjs                 # builds dist/ tarball of the skill
├── skill/                          # the skill itself (symlinked into .claude/skills)
│   ├── SKILL.md                    # orchestration playbook Claude follows
│   ├── package.json                # runtime deps: execa, ajv, ffmpeg-static, ffprobe-static
│   ├── .shortstop-ready            # bootstrap-complete marker
│   ├── assets/
│   │   └── fonts/                  # bundled caption font (Montserrat Bold + OFL)
│   ├── config/
│   │   ├── config.schema.json
│   │   └── default.config.json     # cut/audio/aspect/qa defaults + mode presets
│   ├── models/                     # yunet.onnx + whisper/ cache (downloaded by bootstrap)
│   ├── prompts/                    # idea_segmentation / cut_decisions / qa_gap_fix (Claude judgment stages)
│   ├── schemas/                    # 7 artifact JSON schemas (probe…qa_report, ideas)
│   └── scripts/
│       ├── bootstrap.mjs           # one-time setup (deps, venv, models); import-free until npm install
│       ├── doctor.mjs              # dependency health check (+findEspeak, optional dev checks)
│       ├── probe.mjs               # stage 0: probe + normalize (VFR/rotation/exotic/start-skew)
│       ├── transcribe.mjs|.py      # stage 1: faster-whisper word timestamps
│       ├── silence.mjs             # stage 2: calibrated silencedetect map
│       ├── track.mjs|.py           # stage 3: YuNet face track → crop path (9:16)
│       ├── segment_ideas.mjs       # shorts mode: validates Claude's ideas draft → clipN/ workspaces
│       ├── build_edl.mjs           # stage 4 guardrail: pad/snap/merge/straddle-check Claude's EDL draft
│       ├── build_captions.mjs      # stage 5: karaoke ASS captions (source→output time map)
│       ├── render.mjs              # stage 6: pass A mezzanine + pass B crop/captions/loudness
│       ├── qa.mjs                  # stage 7: measured QA vs reference; exit 4 = gaps
│       ├── deliver.mjs             # ships mp4 (+QA report), refuses hard gaps, prunes runs/
│       └── lib/                    # artifacts(Ajv)/spawn/ffmpeg/venv/timecode/qaloop helpers
└── tests/                          # node --test suites (66 tests)
    ├── fixtures.mjs                # deterministic fixture generator (espeak-ng + ffmpeg, ground truth)
    ├── fixtures/                   # generated clips + manifest (speech/face/vfr/rotated/music…)
    ├── *.test.mjs                  # artifacts, probe, transcribe, silence, build_edl, ideas, track, captions, render, qa, e2e
    ├── clean-install-e2e.mjs       # bare-copy bootstrap → full pipeline check
    └── eval_cut_prompt.md          # manual eval protocol for the judgment stages
```
