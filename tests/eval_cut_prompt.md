# Non-gating Stage 4 prompt eval (PLAN Phase 5)

Quality signal, **not a test** — scripts never call an LLM, so this eval is run by
Claude in a live session, by hand, whenever `prompts/cut_decisions.md` changes.

## Procedure

1. `node tests/fixtures.mjs` — ensure fixtures exist, note the ground truth printed
   (planted filler "Um.", false start "Today we are going", retake, two silences).
2. In a scratch project with the skill installed, copy `tests/fixtures/speech.mp4` to
   `input/` and `tests/fixtures/reference.mp4` to `reference/`, then invoke `/shortstop`.
3. After the run, inspect `runs/<id>/edl.json` and report:
   - [ ] planted filler "Um." removed (`kind: filler`)
   - [ ] false start "Today we are going" removed (`kind: false_start` or `retake`)
   - [ ] retake kept (the full "Today we are going to build something special.")
   - [ ] both planted long pauses removed (`kind: pause`/`silence`)
   - [ ] intro and outro lines kept verbatim
4. Record the pass/fail vector in the PR description. Misses here are prompt-tuning
   signals, never CI failures (Claude's cut choices are nondeterministic by design).
