/**
 * Gherkin keyword definitions for both English and Chinese (zh-CN/zh-TW).
 * Source: https://github.com/cucumber/gherkin/blob/main/gherkin-languages.json
 */

/** Step keywords that introduce a step line */
export const STEP_KEYWORDS = [
  // English
  'Given', 'When', 'Then', 'And', 'But', '*',
  // zh-CN
  '假如', '假设', '假定', '当', '那么', '而且', '并且', '同时', '但是',
  // zh-TW
  '假設', '當', '那麼', '並且', '同時',
] as const;

/** Keywords that represent Given/When/Then type (not continuation) */
export const CONTEXT_KEYWORDS = ['Given', '假如', '假设', '假定', '假設'] as const;
export const ACTION_KEYWORDS = ['When', '当', '當'] as const;
export const OUTCOME_KEYWORDS = ['Then', '那么', '那麼'] as const;

/** Structural keywords that start a new block */
export const FEATURE_KEYWORDS = ['Feature', '功能'] as const;
export const RULE_KEYWORDS = ['Rule', '规则', '規則'] as const;
export const SCENARIO_KEYWORDS = [
  'Scenario Outline', '场景大纲', '剧本大纲', '場景大綱', '劇本大綱',
  'Scenario', '场景', '剧本', '場景', '劇本',
] as const;
export const BACKGROUND_KEYWORDS = ['Background', '背景'] as const;
export const EXAMPLES_KEYWORDS = ['Examples', '例子'] as const;

/**
 * Parse a step line and return the keyword and description text.
 * Example: "假如 用户登录系统" → { keyword: "假如", text: "用户登录系统" }
 */
export function parseStepLine(line: string): { keyword: string; text: string } | undefined {
  const trimmed = line.trimStart();
  for (const kw of STEP_KEYWORDS) {
    const isChinese = /[\p{Script=Han}]/u.test(kw[0]);
    if (isChinese) {
      if (trimmed.startsWith(kw)) {
        return { keyword: kw, text: trimmed.slice(kw.length).trimStart() };
      }
    } else {
      const re = new RegExp(`^${kw}(?:\\s|$)`);
      if (re.test(trimmed)) {
        return { keyword: kw, text: trimmed.slice(kw.length).trimStart() };
      }
    }
  }
  return undefined;
}

/**
 * Get the step type (given/when/then) from a keyword.
 * And/But/* return undefined (they inherit from the previous step).
 */
export function getStepType(keyword: string): 'given' | 'when' | 'then' | undefined {
  if ((CONTEXT_KEYWORDS as readonly string[]).includes(keyword)) {
    return 'given';
  }
  if ((ACTION_KEYWORDS as readonly string[]).includes(keyword)) {
    return 'when';
  }
  if ((OUTCOME_KEYWORDS as readonly string[]).includes(keyword)) {
    return 'then';
  }
  return undefined; // And, But, * — inherit
}

/**
 * Parse a scenario header line and return the scenario name.
 * Example: "  场景: POST major null 落库 NULL" → "POST major null 落库 NULL"
 */
export function parseScenarioLine(line: string): string | undefined {
  const trimmed = line.trimStart();
  // Try longer keywords first (Scenario Outline before Scenario)
  for (const kw of SCENARIO_KEYWORDS) {
    const escaped = kw.replace(/\s+/g, '\\s*');
    const re = new RegExp(`^${escaped}\\s*:\\s*`);
    const m = trimmed.match(re);
    if (m) {
      return trimmed.slice(m[0].length).trim();
    }
  }
  return undefined;
}

/**
 * Check if a line is a structural keyword line (Feature, Scenario, Background, etc.)
 */
export function isStructuralKeyword(line: string): boolean {
  const trimmed = line.trimStart();
  const allKw = [
    ...FEATURE_KEYWORDS, ...RULE_KEYWORDS, ...SCENARIO_KEYWORDS,
    ...BACKGROUND_KEYWORDS, ...EXAMPLES_KEYWORDS,
  ];
  for (const kw of allKw) {
    const escaped = kw.replace(/\s+/g, '\\s*');
    const re = new RegExp(`^${escaped}\\s*:`);
    if (re.test(trimmed)) {
      return true;
    }
  }
  return false;
}

/**
 * Format a scenario name into a valid pytest test function name.
 * Handles Chinese characters by keeping them as-is (Python 3 supports unicode identifiers).
 */
export function formatTestName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s]+/g, '_')
    .replace(/["',.;:!@#$%^&*()+=<>?/\\|~`[\]{}]/g, '')
    .replace(/-/g, '');
}

/**
 * Normalize a decorator string from a Python step definition file.
 * Extracts the step text from patterns like:
 *   @given("some text")
 *   @when(Parser("some {param}"))
 *   @then(r"regex pattern")
 */
export function normalizeDecorator(text: string): string | undefined {
  // Match @keyword(...) pattern
  const decoratorMatch = text.match(/@(\w+)\s*\((.+)\)/s);
  if (!decoratorMatch) {
    return undefined;
  }
  const body = decoratorMatch[2].trim();
  // Extract the string content from quotes
  const strMatch = body.match(/(?:Parser\s*\()?(?:r?["'])(.+?)(?:["'])/s);
  if (strMatch) {
    return strMatch[1].replace(/\\n.*/s, '').trim();
  }
  return undefined;
}

/**
 * Check if a feature step text matches a step definition text.
 * Handles parameterized placeholders: "{param}" in definitions ↔ quoted strings in features.
 * Also handles Chinese text correctly.
 */
export function stepMatchesDefinition(featureStep: string, definitionStep: string): boolean {
  // Normalize both: lowercase, replace parameterized parts with placeholder
  const normalize = (s: string): string => {
    return s
      .toLowerCase()
      .replace(/["'][^"']*["']/g, '_')   // "quoted" → _
      .replace(/\{[^}]+\}/g, '_')         // {param} → _
      .replace(/<[^>]+>/g, '_')           // <placeholder> → _
      .replace(/\s+/g, ' ')
      .trim();
  };
  return normalize(featureStep) === normalize(definitionStep);
}
