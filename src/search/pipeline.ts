import type { StepScanContributor } from '../profiles/types';
import type { ExtractedStepPartial, ProfileId } from '../profiles/types';
import { mightContainStepDefs } from './fingerprints';
import { languageFromPath, type SourceLanguage } from './languages';

export interface ScanPipelineStats {
  candidates: number;
  skippedPath: number;
  skippedFingerprint: number;
  parsed: number;
  definitions: number;
  bytesRead: number;
}

export interface PipelineExtracted extends ExtractedStepPartial {
  contributorId: ProfileId;
  frameworkId: ProfileId;
  lang: 'python' | 'rust' | 'typescript';
}

function frameworkForPartial(contributorId: ProfileId, partial: ExtractedStepPartial): ProfileId {
  if (partial.matcherKind === 'parse-lite') {
    return 'member-dsl-bdd';
  }
  return contributorId;
}

function contributorMatchesLang(c: StepScanContributor, lang: SourceLanguage): boolean {
  if (lang === 'javascript') {
    return c.languages.includes('typescript');
  }
  return c.languages.includes(lang);
}

function contributorsForFile(
  relPath: string,
  contributors: readonly StepScanContributor[],
): StepScanContributor[] {
  const lang = languageFromPath(relPath);
  if (!lang) {
    return [];
  }
  const out: StepScanContributor[] = [];
  for (const c of contributors) {
    if (!contributorMatchesLang(c, lang)) {
      continue;
    }
    if (c.shouldSkipFile(relPath)) {
      continue;
    }
    out.push(c);
  }
  return out;
}

/**
 * Search plane core: path + text → step partials (no vscode.Uri).
 * Callers supply text (full or head); fingerprint runs before extractors.
 */
export function extractFromSource(
  relPath: string,
  source: string,
  contributors: readonly StepScanContributor[],
  stats?: ScanPipelineStats,
): PipelineExtracted[] {
  if (stats) {
    stats.candidates++;
  }
  const applicable = contributorsForFile(relPath, contributors);
  if (applicable.length === 0) {
    if (stats) {
      stats.skippedPath++;
    }
    return [];
  }
  if (!mightContainStepDefs(relPath, source)) {
    if (stats) {
      stats.skippedFingerprint++;
    }
    return [];
  }
  if (stats) {
    stats.bytesRead += Buffer.byteLength(source, 'utf8');
  }
  const defs: PipelineExtracted[] = [];
  for (const c of applicable) {
    if (!c.filePrefilter(source, relPath)) {
      continue;
    }
    if (stats) {
      stats.parsed++;
    }
    for (const d of c.extract(source, relPath)) {
      const frameworkId = frameworkForPartial(c.id, d);
      defs.push({
        ...d,
        contributorId: c.id,
        frameworkId,
        lang: c.languages[0],
      });
    }
  }
  if (stats) {
    stats.definitions += defs.length;
  }
  return defs;
}
