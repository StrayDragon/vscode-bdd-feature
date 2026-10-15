import type { StepScanContributor } from '../profiles/types';
import { mightContainStepDefs } from './fingerprints';
import { internPattern } from './intern';
import { extractFromSource, type PipelineExtracted, type ScanPipelineStats } from './pipeline';
import { readFileHeadOrFull } from './partialRead';

/** Parse one file; intern pattern text for memory sharing. */
export async function scanFileAtPath(
  absPath: string,
  relPath: string,
  contributors: readonly StepScanContributor[],
  stats?: ScanPipelineStats,
): Promise<PipelineExtracted[]> {
  const text = await readFileHeadOrFull(absPath, chunk => mightContainStepDefs(relPath, chunk));
  const raw = extractFromSource(relPath, text, contributors, stats);
  return raw.map(d => ({ ...d, text: internPattern(d.text) }));
}
