/**
 * The review feedback sounds, shared by the review view, the homepage widget,
 * and audio review so all three sound identical. Oscillator-based, no assets.
 * Correct: two-note rising chime. Incorrect: low square-wave buzz.
 * Returns how long the sound lasts, in ms, for callers that sequence audio.
 */
export function playFeedbackSound(ctx: AudioContext, correct: boolean): number {
  try {
    const now = ctx.currentTime;
    if (correct) {
      for (const [freq, onset, dur] of [[523.25, 0, 0.12], [783.99, 0.06, 0.18]] as const) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, now + onset);
        g.gain.exponentialRampToValueAtTime(0.18, now + onset + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, now + onset + dur);
        osc.connect(g).connect(ctx.destination);
        osc.start(now + onset);
        osc.stop(now + onset + dur);
      }
      return 240;
    }
    const dur = 0.12;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = 220;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.25, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur);
    return 120;
  } catch {
    return 0;
  }
}
