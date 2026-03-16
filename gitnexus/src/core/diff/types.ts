export type ChangeKind = 'Added' | 'Removed' | 'Renamed' | 'SignatureChanged' | 'VisibilityChanged' | 'BodyChanged';

export interface Definition {
  qualifiedName: string;
  name: string;
  label: string;            // 'Function' | 'Class' | 'Method' | 'Interface' | ...
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string;
  paramTypes: string[];
  returnType: string;
  isExported: boolean;
  decorators: string[];
  baseClasses: string[];
  lines: number;
}

export interface FieldDelta {
  field: string;             // 'param_types' | 'return_type' | 'is_exported' | 'signature' | 'decorators' | 'base_classes'
  old: string;
  new: string;
}

export interface SymbolChange {
  kind: ChangeKind;
  label: string;
  name: string;
  qualifiedName: string;
  oldQualifiedName?: string; // for renames
  filePath: string;
  deltas: FieldDelta[];
  isBreaking: boolean;
}

export interface CommitGroup {
  scope: string;             // e.g. 'auth', 'pipeline', filename
  draftMessage: string;
  reason: string;            // 'coupled: X calls Y' | 'test + source' | 'same file'
  files: string[];
  changes: SymbolChange[];
}

export interface CommitPlan {
  groups: CommitGroup[];
  ungrouped: SymbolChange[];
}
