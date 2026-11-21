// Lowering source maps (RT20).
//
// Both lowering passes rewrite the author's file as a list of non-overlapping
// text edits, so the generated file is mostly the original with holes punched
// in it. That shape is what makes a map cheap: every piece of the output is
// either a verbatim run of the input — which maps character for character —
// or a replacement, which maps to the start of what it replaced.
//
// The distinction is kept rather than smoothed over. `exact` says the column
// is the author's own column; an inexact piece can only honestly point at the
// construct the lowering consumed, because the text being pointed at is text
// the author never wrote. Callers may show that difference; none of them may
// invent a column inside generated text.

/** @typedef {{start: number, length: number, source: number, exact: boolean}} Segment */

/**
 * Apply non-overlapping `{start, end, text}` edits to `text`, recording where
 * each piece of the result came from. Edits may be given in any order.
 */
export function applyEdits(text, edits) {
  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const segments = [];
  let out = "";
  let cursor = 0;
  for (const edit of ordered) {
    if (edit.start < cursor) {
      throw new Error(`overlapping lowering edit at ${edit.start} (after ${cursor})`);
    }
    if (edit.start > cursor) {
      segments.push({ start: out.length, length: edit.start - cursor, source: cursor, exact: true });
      out += text.slice(cursor, edit.start);
    }
    if (edit.text.length > 0) {
      segments.push({ start: out.length, length: edit.text.length, source: edit.start, exact: false });
      out += edit.text;
    }
    cursor = edit.end;
  }
  if (cursor < text.length) {
    segments.push({ start: out.length, length: text.length - cursor, source: cursor, exact: true });
    out += text.slice(cursor);
  }
  return { text: out, segments };
}

function findSegment(segments, offset) {
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const segment = segments[mid];
    if (offset < segment.start) high = mid - 1;
    else if (offset >= segment.start + segment.length) low = mid + 1;
    else return segment;
  }
  return null;
}

/**
 * Resolve a generated offset to its input offset. An offset past the last
 * segment (text appended after the mapped region) resolves to the end of the
 * input, never to a position it could be confused with.
 */
export function originalOffset(segments, offset) {
  const segment = findSegment(segments, offset);
  if (!segment) {
    const last = segments[segments.length - 1];
    const end = last ? last.source + (last.exact ? last.length : 0) : 0;
    return { offset: end, exact: false };
  }
  return segment.exact
    ? { offset: segment.source + (offset - segment.start), exact: true }
    : { offset: segment.source, exact: false };
}

/**
 * Compose two passes: `first` maps pass one's output onto the original,
 * `second` maps pass two's output onto pass one's. An exact run of the second
 * pass is split wherever the first pass changes how it maps, so composing
 * never widens an exact mapping into a guess.
 */
export function composeSegments(first, second) {
  const out = [];
  for (const segment of second) {
    if (!segment.exact) {
      out.push({
        start: segment.start,
        length: segment.length,
        source: originalOffset(first, segment.source).offset,
        exact: false,
      });
      continue;
    }
    let consumed = 0;
    while (consumed < segment.length) {
      const middle = segment.source + consumed;
      const piece = findSegment(first, middle);
      if (!piece) {
        out.push({
          start: segment.start + consumed,
          length: segment.length - consumed,
          source: originalOffset(first, middle).offset,
          exact: false,
        });
        break;
      }
      const available = Math.min(segment.length - consumed, piece.start + piece.length - middle);
      out.push({
        start: segment.start + consumed,
        length: available,
        source: piece.exact ? piece.source + (middle - piece.start) : piece.source,
        exact: piece.exact,
      });
      consumed += available;
    }
  }
  return out;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineOf(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function encodeVlq(value) {
  let bits = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = bits & 0b11111;
    bits >>>= 5;
    if (bits > 0) digit |= 0b100000;
    out += BASE64[digit];
  } while (bits > 0);
  return out;
}

/** Decode one Source Map v3 `mappings` string into per-line field arrays. */
export function decodeMappings(mappings) {
  const lines = [];
  let sourceIndex = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  let nameIndex = 0;
  for (const line of mappings.split(";")) {
    const fields = [];
    let generatedColumn = 0;
    for (const group of line.split(",").filter(Boolean)) {
      const values = [];
      let shift = 0;
      let current = 0;
      for (const character of group) {
        const digit = BASE64.indexOf(character);
        if (digit < 0) throw new Error(`invalid VLQ character ${character}`);
        current += (digit & 0b11111) << shift;
        if (digit & 0b100000) {
          shift += 5;
          continue;
        }
        values.push(current & 1 ? -(current >> 1) : current >> 1);
        shift = 0;
        current = 0;
      }
      generatedColumn += values[0];
      if (values.length >= 4) {
        sourceIndex += values[1];
        sourceLine += values[2];
        sourceColumn += values[3];
        if (values.length >= 5) {
          nameIndex += values[4];
          fields.push({ generatedColumn, sourceIndex, sourceLine, sourceColumn, nameIndex });
        } else fields.push({ generatedColumn, sourceIndex, sourceLine, sourceColumn });
      } else fields.push({ generatedColumn });
    }
    lines.push(fields);
  }
  return lines;
}

/** Re-encode what [`decodeMappings`] produced, deltas and all. */
export function encodeMappings(lines) {
  let sourceIndex = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  let nameIndex = 0;
  return lines
    .map((fields) => {
      let generatedColumn = 0;
      return fields
        .map((field) => {
          let out = encodeVlq(field.generatedColumn - generatedColumn);
          generatedColumn = field.generatedColumn;
          if (field.sourceIndex === undefined) return out;
          out +=
            encodeVlq(field.sourceIndex - sourceIndex) +
            encodeVlq(field.sourceLine - sourceLine) +
            encodeVlq(field.sourceColumn - sourceColumn);
          sourceIndex = field.sourceIndex;
          sourceLine = field.sourceLine;
          sourceColumn = field.sourceColumn;
          if (field.nameIndex !== undefined) {
            out += encodeVlq(field.nameIndex - nameIndex);
            nameIndex = field.nameIndex;
          }
          return out;
        })
        .join(",");
    })
    .join(";");
}

/** One lowered file's map back to the source its author wrote. */
export class LoweringMap {
  constructor({ source, sourceName, generated, segments }) {
    this.source = source;
    this.sourceName = sourceName;
    this.generated = generated;
    this.segments = segments;
    this.generatedLines = lineStarts(generated);
    this.sourceLines = lineStarts(source);
  }

  /** An identity map, for a file no pass rewrote. */
  static identity(source, sourceName) {
    return new LoweringMap({
      source,
      sourceName,
      generated: source,
      segments: source.length
        ? [{ start: 0, length: source.length, source: 0, exact: true }]
        : [],
    });
  }

  /** 1-based generated line/column to the 1-based position its author wrote. */
  originalPositionFor(line, column) {
    const start = this.generatedLines[Math.min(Math.max(line, 1), this.generatedLines.length) - 1];
    const offset = Math.min(start + Math.max(column, 1) - 1, this.generated.length);
    const resolved = originalOffset(this.segments, offset);
    const index = lineOf(this.sourceLines, Math.min(resolved.offset, this.source.length));
    return {
      line: index + 1,
      column: Math.min(resolved.offset, this.source.length) - this.sourceLines[index] + 1,
      exact: resolved.exact,
    };
  }

  /**
   * A Source Map v3 for the lowered file. Every generated line carries a
   * mapping at its first column plus one wherever a segment begins, which is
   * exactly where the correspondence changes.
   */
  toSourceMapV3({ file }) {
    let previousSourceLine = 0;
    let previousSourceColumn = 0;
    const lines = [];
    for (let index = 0; index < this.generatedLines.length; index++) {
      const lineStart = this.generatedLines[index];
      const lineEnd = index + 1 < this.generatedLines.length
        ? this.generatedLines[index + 1]
        : this.generated.length;
      const columns = new Set([lineStart]);
      for (const segment of this.segments) {
        if (segment.start >= lineStart && segment.start < lineEnd) columns.add(segment.start);
      }
      let previousGeneratedColumn = 0;
      const fields = [];
      for (const offset of [...columns].sort((a, b) => a - b)) {
        const position = this.originalPositionFor(index + 1, offset - lineStart + 1);
        const sourceLine = position.line - 1;
        const sourceColumn = position.column - 1;
        const generatedColumn = offset - lineStart;
        fields.push(
          encodeVlq(generatedColumn - previousGeneratedColumn) +
            encodeVlq(0) +
            encodeVlq(sourceLine - previousSourceLine) +
            encodeVlq(sourceColumn - previousSourceColumn),
        );
        previousGeneratedColumn = generatedColumn;
        previousSourceLine = sourceLine;
        previousSourceColumn = sourceColumn;
      }
      lines.push(fields.join(","));
    }
    return {
      version: 3,
      file,
      sources: [this.sourceName],
      sourcesContent: [this.source],
      names: [],
      mappings: lines.join(";"),
    };
  }
}

/**
 * Point a compiler's own source map at the author's file. Only the entries
 * for the lowered file move; AssemblyScript's standard library is in the same
 * map and is left exactly where it is, so a breakpoint in `~lib` still lands.
 */
export function remapGeneratedSourceMap(map, loweredName, lowering) {
  const index = map.sources.findIndex(
    (name) => name === loweredName || name.split(/[\\/]/).pop() === loweredName,
  );
  if (index < 0) return map;
  const lines = decodeMappings(map.mappings).map((fields) =>
    fields.map((field) => {
      if (field.sourceIndex !== index) return field;
      const position = lowering.originalPositionFor(field.sourceLine + 1, field.sourceColumn + 1);
      return { ...field, sourceLine: position.line - 1, sourceColumn: position.column - 1 };
    }),
  );
  const sources = [...map.sources];
  sources[index] = lowering.sourceName;
  const remapped = { ...map, sources, mappings: encodeMappings(lines) };
  if (Array.isArray(map.sourcesContent)) {
    remapped.sourcesContent = [...map.sourcesContent];
    remapped.sourcesContent[index] = lowering.source;
  }
  return remapped;
}

const LOCATION = /\bin ([^\s()]+)\((\d+),(\d+)\)/g;

/**
 * Rewrite the `in <file>(line,column)` footers AssemblyScript prints so they
 * name the file the author wrote. The lowered position is kept alongside it:
 * the frame above it quotes lowered text, and a position that no longer
 * matches the text beside it would be worse than no mapping at all.
 *
 * `maps` is keyed by the generated file name asc reports.
 */
export function mapCompilerDiagnostics(text, maps) {
  if (!text || maps.size === 0) return text;
  return text.replace(LOCATION, (whole, file, line, column) => {
    // asc names the entry the way it was given it: a bare name under
    // `--baseDir`, a path when linking several units.
    const map = maps.get(file) ?? maps.get(file.split(/[\\/]/).pop());
    if (!map) return whole;
    const position = map.originalPositionFor(Number(line), Number(column));
    return `in ${map.sourceName}(${position.line},${position.column}) [lowered ${file}(${line},${column})]`;
  });
}
