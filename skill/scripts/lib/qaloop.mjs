// The §8 fix-and-recheck cycle as a pure, injectable skeleton.
// SKILL.md has Claude drive this exact semantics in-session (Claude supplies the
// `fix` judgment); tests drive it with canned callbacks to prove the invariants:
// measure-first ordering, 5-attempt ceiling, score-based no-progress guard,
// best-candidate tracking, soft-deliver / hard-refuse rules.

export function hasHardGaps(report) {
  return report.gaps.some((g) => g.severity === 'hard');
}

export function deliveryDecision(report) {
  if (report.verdict === 'pass') return 'deliver';
  return hasHardGaps(report) ? 'refuse' : 'deliver-with-report';
}

// renderAndMeasure(attempt) → report ; fix(report, attempt) → applies a change
// (returns false to signal "no fix available", which ends the loop).
export async function runQaLoop({ renderAndMeasure, fix, maxFixAttempts = 5 }) {
  const history = [];
  let best = await renderAndMeasure(0);
  history.push(best);
  let noProgress = 0;
  let attempt = 0;

  while (attempt < maxFixAttempts && best.verdict !== 'pass') {
    attempt += 1;
    const applied = await fix(best, attempt);
    if (applied === false) break;
    const report = await renderAndMeasure(attempt); // measure-first: every fix is rendered+measured
    history.push(report);
    if (report.score > best.score) {
      best = report;
      noProgress = 0;
    } else {
      noProgress += 1;
      if (noProgress >= 2) break; // score-based guard (EDL equality is not the guard)
    }
  }

  return { best, attempts: attempt, history, decision: deliveryDecision(best) };
}
