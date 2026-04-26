/**
 * Estimate Anthropic vision token cost for an image of the given pixel dimensions.
 *
 * Anthropic's vision documentation states roughly tokens ≈ (width * height) / 750.
 * Cap at a reasonable upper bound so absurdly large inputs don't produce silly numbers.
 */
export function estimateImageTokens(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 0;
  }
  const raw = (width * height) / 750;
  // Anthropic caps at ~1.15M pixels for a 1568px long-edge square-ish image (~1600 tokens).
  // Use a generous cap so the estimate stays informative without going wild.
  const CAP = 10000;
  return Math.min(Math.round(raw), CAP);
}
