/**
 * Output Format Module
 *
 * Manages the per-invocation output format (yaml or json) for CLI output.
 * YAML is the default — it is more token-efficient and easier to scan.
 *
 * MCP server responses are always JSON (hardcoded in server.ts).
 */

import { stringify as yamlStringify } from 'yaml';

export type OutputFormat = 'yaml' | 'json';

let currentFormat: OutputFormat = 'yaml';

/** Set the output format. Returns the new format string. */
export function setOutputFormat(format: string): OutputFormat {
  if (format !== 'yaml' && format !== 'json') {
    throw new Error(`Invalid format "${format}" — must be "yaml" or "json"`);
  }
  currentFormat = format;
  return currentFormat;
}

/**
 * Serialize a result to the current output format (CLI use).
 *
 * - Strings are returned as-is (already formatted — e.g. markdown tables).
 * - Objects/arrays are serialized to YAML or JSON depending on the invocation format.
 */
export function formatResult(data: any): string {
  if (typeof data === 'string') return data;
  if (currentFormat === 'yaml') {
    return yamlStringify(data, { indent: 2, lineWidth: 120, defaultStringType: 'PLAIN' });
  }
  return JSON.stringify(data, null, 2);
}
