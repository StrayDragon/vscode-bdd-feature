import type { SourceLanguage } from './languages';
import { languageFromPath, tsJsFamily } from './languages';

/**
 * Cheap, language-specific "might contain step registrations" probes.
 * One alternation per language — run once per file before full parsing.
 */
const PY = /@(given|when|then|step)\b|pytest_bdd|from pytest_bdd/;
const RS = /#\[\s*(given|when|then)\s*\(/;
const TS =
  /\b(Given|When|Then|defineStep)\s*[(@]|\.(given|when|then|thenStep)\s*\(\s*['"`]/;

const BY_FAMILY: Record<'python' | 'rust' | 'typescript', RegExp> = {
  python: PY,
  rust: RS,
  typescript: TS,
};

/** True when `chunk` may contain step defs for this path's language. */
export function mightContainStepDefs(relPath: string, chunk: string): boolean {
  const family = tsJsFamily(languageFromPath(relPath));
  if (!family) {
    return false;
  }
  return BY_FAMILY[family].test(chunk);
}
