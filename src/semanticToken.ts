import * as vscode from 'vscode';

const TOKEN_TYPES = [
  'comment', 'string', 'keyword', 'number', 'regexp', 'operator', 'namespace',
  'type', 'struct', 'class', 'interface', 'enum', 'typeParameter', 'function',
  'member', 'macro', 'variable', 'parameter', 'property', 'label',
  'gherkin-table-header',
];

const TOKEN_MODIFIERS = [
  'declaration', 'documentation', 'readonly', 'static', 'abstract', 'deprecated',
  'modification', 'async',
];

const tokenTypeMap = new Map<string, number>();
TOKEN_TYPES.forEach((t, i) => tokenTypeMap.set(t, i));

const tokenModifierMap = new Map<string, number>();
TOKEN_MODIFIERS.forEach((m, i) => tokenModifierMap.set(m, i));

export const semanticTokensLegend = new vscode.SemanticTokensLegend(TOKEN_TYPES, TOKEN_MODIFIERS);

interface ParsedToken {
  line: number;
  startCharacter: number;
  length: number;
  tokenType: string;
  tokenModifiers: string[];
}

/**
 * Provides semantic tokens for .feature files.
 * Currently highlights table header rows (first row of a table block).
 */
export class FeatureSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
  async provideDocumentSemanticTokens(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): Promise<vscode.SemanticTokens> {
    const tokens = this._parseDocument(document);
    const builder = new vscode.SemanticTokensBuilder(semanticTokensLegend);
    for (const token of tokens) {
      builder.push(
        token.line,
        token.startCharacter,
        token.length,
        this._encodeTokenType(token.tokenType),
        this._encodeTokenModifiers(token.tokenModifiers),
      );
    }
    return builder.build();
  }

  private _parseDocument(document: vscode.TextDocument): ParsedToken[] {
    const tokens: ParsedToken[] = [];

    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i).text;
      const trimmed = line.trimStart();

      // Detect table rows
      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
        // Check if this is the first row of a table (header)
        const isHeader = i === 0 || !document.lineAt(i - 1).text.trimStart().startsWith('|');
        if (isHeader) {
          // Tokenize each cell in the header row
          const cells = trimmed.split('|').filter(c => c.trim().length > 0);
          let offset = line.indexOf('|') + 1;
          for (const cell of cells) {
            const cellStart = line.indexOf(cell.trim(), offset);
            if (cellStart >= 0) {
              tokens.push({
                line: i,
                startCharacter: cellStart,
                length: cell.trim().length,
                tokenType: 'gherkin-table-header',
                tokenModifiers: [],
              });
              offset = cellStart + cell.length;
            }
          }
        }
      }
    }

    return tokens;
  }

  private _encodeTokenType(tokenType: string): number {
    return tokenTypeMap.get(tokenType) ?? 0;
  }

  private _encodeTokenModifiers(modifiers: string[]): number {
    let result = 0;
    for (const mod of modifiers) {
      const index = tokenModifierMap.get(mod);
      if (index !== undefined) {
        result |= (1 << index);
      }
    }
    return result;
  }
}
