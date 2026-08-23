#!/usr/bin/env node
/**
 * Refresh the vendored Gherkin language data from the official spec.
 *
 * Source of truth: cucumber/gherkin `gherkin-languages.json`
 * (https://github.com/cucumber/gherkin — MIT licensed).
 *
 * Usage: node scripts/update-gherkin-languages.mjs
 */
import { writeFile } from 'node:fs/promises';

const URL =
  'https://raw.githubusercontent.com/cucumber/gherkin/main/gherkin-languages.json';
const OUT = new URL('../src/gherkin/gherkin-languages.json', import.meta.url);

const res = await fetch(URL);
if (!res.ok) {
  console.error(`Download failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const body = await res.text();
JSON.parse(body); // sanity check
await writeFile(OUT, body);
console.log('Updated src/gherkin/gherkin-languages.json');
