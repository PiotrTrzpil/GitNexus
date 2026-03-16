//! Source text utilities: line/column conversion and text extraction from AST spans.

use oxc_span::Span;

/// A lookup table mapping byte offsets to line numbers (1-indexed).
///
/// Built once per file and reused for all span conversions.
pub struct LineIndex {
    /// Byte offset of the start of each line (0-indexed array, line[0] = offset of line 1).
    line_starts: Vec<u32>,
}

impl LineIndex {
    /// Build a line index from source text by scanning for newline characters.
    pub fn new(source: &str) -> Self {
        let mut line_starts = vec![0u32];
        for (offset, ch) in source.char_indices() {
            if ch == '\n' {
                line_starts.push(offset as u32 + 1);
            }
        }
        Self { line_starts }
    }

    /// Convert a byte offset to a (line, column) pair, both 1-indexed.
    ///
    /// Returns `(1, 1)` for an offset of 0. Clamps to the last line if the offset
    /// is past the end of source.
    pub fn offset_to_line_col(&self, offset: u32) -> (u32, u32) {
        // Binary search for the line containing this offset.
        match self.line_starts.binary_search(&offset) {
            // Exact match: this offset is the start of a line.
            Ok(idx) => (idx as u32 + 1, 1),
            Err(idx) => {
                // `idx` is the insertion point — the line starts are all < offset.
                // The offset falls within line `idx` (1-indexed: idx, because arrays are 0-indexed).
                let line = idx; // 1-indexed line number
                let line_start = self.line_starts[idx - 1];
                let col = offset - line_start + 1;
                (line as u32, col)
            }
        }
    }
}

/// Extract source text for a given span, truncated to `max_len` chars.
///
/// Returns `None` if the span is empty or out of bounds.
pub fn extract_text<'a>(source: &'a str, span: Span, max_len: usize) -> Option<&'a str> {
    let start = span.start as usize;
    let end = span.end as usize;

    if start >= end || end > source.len() {
        return None;
    }

    let text = &source[start..end];
    if text.is_empty() {
        return None;
    }

    // Truncate to max_len chars (not bytes) to avoid splitting multi-byte sequences.
    let truncated = truncate_to_chars(text, max_len);
    Some(truncated)
}

/// Truncate a string to at most `max_chars` Unicode characters.
#[inline]
fn truncate_to_chars(s: &str, max_chars: usize) -> &str {
    match s.char_indices().nth(max_chars) {
        Some((byte_idx, _)) => &s[..byte_idx],
        None => s,
    }
}

/// Extract condition text for a `Jump` edge from the Condition instruction's span.
/// Truncates to 120 chars as per the design contract.
pub fn extract_condition_text(source: &str, span: Span) -> Option<String> {
    extract_text(source, span, 120).map(|s| s.to_string())
}

/// Extract instruction text (for Return/Throw expressions).
/// Truncates to 200 chars as per the design contract.
pub fn extract_instruction_text(source: &str, span: Span) -> Option<String> {
    extract_text(source, span, 200).map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_span::Span;

    #[test]
    fn test_line_index_basic() {
        let source = "line1\nline2\nline3";
        let idx = LineIndex::new(source);
        // "line1" starts at 0, "line2" starts at 6, "line3" starts at 12
        assert_eq!(idx.line_starts, vec![0, 6, 12]);
        assert_eq!(idx.offset_to_line_col(0), (1, 1));
        assert_eq!(idx.offset_to_line_col(5), (1, 6)); // '\n' itself
        assert_eq!(idx.offset_to_line_col(6), (2, 1)); // start of line2
        assert_eq!(idx.offset_to_line_col(7), (2, 2));
        assert_eq!(idx.offset_to_line_col(12), (3, 1));
    }

    #[test]
    fn test_extract_text_truncates() {
        let source = "abcdefghij";
        let span = Span::new(0, 10);
        let result = extract_text(source, span, 5);
        assert_eq!(result, Some("abcde"));
    }

    #[test]
    fn test_extract_text_out_of_bounds() {
        let source = "abc";
        let span = Span::new(0, 10);
        let result = extract_text(source, span, 200);
        assert_eq!(result, None);
    }
}
