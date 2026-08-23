/**
 * Faithful port of pytest-bdd's generated test-name rules
 * (see pytest_bdd/scenario.py: make_python_name / get_python_name_generator).
 *
 *   make_python_name: spaces→'_', strip non-\w (Unicode aware), lowercase,
 *                     strip leading digits+underscores
 *   test function name: "test_" + python_name
 *
 * JS `\w` is ASCII-only even with the u flag, so Unicode word chars must be
 * matched explicitly via \p{L}\p{N} to behave like Python's re.
 */

export function makePythonName(name: string): string {
  const underscored = name.replace(/ /g, '_');
  // Python re \W with str patterns is Unicode-aware:
  // keep letters (any script), numbers, underscore; drop the rest.
  const stripped = underscored.replace(/[^\p{L}\p{N}_]/gu, '');
  return stripped.replace(/^\d+_*/, '').toLowerCase();
}

export function pytestTestName(scenarioName: string): string {
  return `test_${makePythonName(scenarioName)}`;
}
