/**
 * Flyweight pool for step pattern strings — duplicate patterns across files
 * share one heap instance (important for large monorepos).
 */
const POOL = new Map<string, string>();
const MAX_ENTRIES = 200_000;

export function internPattern(text: string): string {
  const hit = POOL.get(text);
  if (hit !== undefined) {
    return hit;
  }
  if (POOL.size >= MAX_ENTRIES) {
    POOL.clear();
  }
  POOL.set(text, text);
  return text;
}

export function clearPatternInternPool(): void {
  POOL.clear();
}

export function patternInternPoolSize(): number {
  return POOL.size;
}
