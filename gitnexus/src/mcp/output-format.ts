/**
 * Output Format Module
 *
 * Manages the session-persistent output format (yaml or json) for MCP tool
 * responses and CLI output. YAML is the default — it is more token-efficient
 * and easier to scan than JSON for LLM consumers.
 *
 * Port of codebase-memory-mcp's set_output_format / result() pattern.
 */

import { stringify as yamlStringify } from 'yaml';

export type OutputFormat = 'yaml' | 'json';

let currentFormat: OutputFormat = 'yaml';

/** Get the current output format. */
export function getOutputFormat(): OutputFormat {
  return currentFormat;
}

/** Set the output format. Returns the new format string. */
export function setOutputFormat(format: string): OutputFormat {
  if (format !== 'yaml' && format !== 'json') {
    throw new Error(`Invalid format "${format}" — must be "yaml" or "json"`);
  }
  currentFormat = format;
  return currentFormat;
}

/**
 * Serialize a tool result to the current output format.
 *
 * - Strings are returned as-is (already formatted — e.g. markdown tables).
 * - Objects/arrays are serialized to YAML or JSON depending on the session format.
 */
export function formatResult(data: any): string {
  if (typeof data === 'string') return data;
  if (currentFormat === 'yaml') {
    return yamlStringify(data, { indent: 2, lineWidth: 120, defaultStringType: 'PLAIN' });
  }
  return JSON.stringify(data, null, 2);
}
