/** Source languages we can fingerprint and parse for step registrations. */
export type SourceLanguage = 'python' | 'rust' | 'typescript' | 'javascript';

export function languageFromPath(relPath: string): SourceLanguage | undefined {
  const lower = relPath.toLowerCase();
  if (lower.endsWith('.py')) {
    return 'python';
  }
  if (lower.endsWith('.rs')) {
    return 'rust';
  }
  if (lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.mts') || lower.endsWith('.cts')) {
    return 'typescript';
  }
  if (
    lower.endsWith('.js') ||
    lower.endsWith('.jsx') ||
    lower.endsWith('.mjs') ||
    lower.endsWith('.cjs')
  ) {
    return 'javascript';
  }
  return undefined;
}

/** TS and JS share the same step-registration shapes in this extension. */
export function tsJsFamily(lang: SourceLanguage | undefined): 'typescript' | 'python' | 'rust' | undefined {
  if (!lang) {
    return undefined;
  }
  if (lang === 'javascript') {
    return 'typescript';
  }
  return lang;
}
