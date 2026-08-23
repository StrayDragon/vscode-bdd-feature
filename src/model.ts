/** Unified step-definition & binding model shared by all providers. */

import * as vscode from 'vscode';

export type StepLang = 'python' | 'rust';

export type StepType = 'given' | 'when' | 'then' | 'step';

/**
 * How a definition's text should be interpreted when matching feature steps.
 *   exact  — verbatim equality (pytest-bdd bare string / rstest without braces)
 *   parse  — Python `parse` format string ({x}, {x:d}, ...)
 *   cfparse— parse + cardinality fields (degrades to parse semantics here)
 *   re     — regular expression
 */
export type StepMatcherKind = 'exact' | 'parse' | 'cfparse' | 're';

export interface StepDefinition {
  lang: StepLang;
  type: StepType;
  matcherKind: StepMatcherKind;
  /** Step pattern text as written in the definition */
  text: string;
  /** Containing file */
  file: vscode.Uri;
  /** Decorator/attribute start line (0-based) */
  decoratorLine: number;
  /** Function definition line (0-based), when discovered */
  functionLine?: number;
  functionName?: string;
  /**
   * Precise range of the pattern text inside its quotes — used as the
   * LocationLink.targetSelectionRange so jumps land exactly on the pattern.
   */
  patternSelection?: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  };
}

/** A binding between a feature(-scenario) and executable test code. */
export interface FeatureBinding {
  lang: StepLang;
  /** File containing the binding call/attribute */
  file: vscode.Uri;
  /** Line of the scenarios()/scenario() call or #[scenario] attribute */
  line: number;
  /** Rust only: generated test function name to pass to cargo test */
  rustTestFnName?: string;
}
