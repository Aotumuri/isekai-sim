/** Paired seed bootstrap, percentile interval; no independence between wars
 * within the same seed is assumed. Fixed local RNG never touches simulation. */
export function pairedBootstrap(values: readonly number[], resamples = 10_000) {
  if (!values.length || values.some((n) => !Number.isFinite(n))) throw new Error("Finite nonempty sample required");
  if (!Number.isSafeInteger(resamples) || resamples < 1) throw new Error("Positive resample count required");
  let state = 0x713ab29d;
  const randomIndex = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor(state / 4294967296 * values.length);
  };
  const samples: number[] = [];
  for (let i = 0; i < resamples; i++) {
    let sum = 0;
    for (let j = 0; j < values.length; j++) sum += values[randomIndex()];
    samples.push(sum / values.length);
  }
  samples.sort((a, b) => a - b);
  return { meanDelta: values.reduce((a, b) => a + b, 0) / values.length,
    lower95: samples[Math.floor(resamples * 0.025)],
    upper95: samples[Math.min(resamples - 1, Math.floor(resamples * 0.975))],
    n: values.length, resamples };
}
