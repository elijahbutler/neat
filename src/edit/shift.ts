// Moves source tags (`file:line:column`) across text edits. Pure string work: nothing here touches the file system.

/** One replaced range of a file: `[start, end)` in the text before the edit became `length` characters. */
export interface Span { start: number; end: number; length: number }
export interface FileSpan extends Span { file: string }

const TAG = /^(.*\.[jt]sx?):(\d+):(\d+)$/;

/** Offset of a one-based line and column, counting lines the way source tags do: split on `\n`. Null when out of range. */
export function offsetOf(text: string, line: number, column: number): number | null {
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || column < 1) return null;
  const lines = text.split('\n');
  const source = lines[line - 1];
  if (source === undefined || column > source.length) return null;
  let offset = 0;
  for (let i = 0; i < line - 1; i++) offset += lines[i]!.length + 1;
  return offset + column - 1;
}

/** One-based line and column of an offset, the inverse of `offsetOf`. */
export function lineColumnOf(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  return { line, column: offset - (before.lastIndexOf('\n') + 1) + 1 };
}

/**
 * Where an offset lands after the spans are applied. Spans must be sorted and not overlap. Text inserted exactly at
 * the offset goes in front of it. Null when the offset sits inside replaced text, because nothing says where it went.
 */
export function mapOffset(offset: number, spans: readonly Span[]): number | null {
  let delta = 0;
  for (const span of spans) {
    if (span.end <= offset && (span.start < offset || span.start === span.end)) delta += span.length - (span.end - span.start);
    else if (span.start < offset) return null;
    else if (span.start === offset && span.end > span.start) return null;
    else break;
  }
  return offset + delta;
}

/** The spans that undo these ones, in the coordinates of the text after them. */
export function invertSpans(spans: readonly Span[]): Span[] {
  let shift = 0;
  return spans.map((span) => {
    const start = span.start + shift;
    shift += span.length - (span.end - span.start);
    return { start, end: start + span.length, length: span.end - span.start };
  });
}

const tagNameAt = (text: string, offset: number) => /^<([A-Za-z_$][\w$.:-]*)/.exec(text.slice(offset, offset + 200))?.[1] ?? null;

/**
 * The tag of the same element after the spans were applied, or null when that can't be shown: the position is
 * outside the text, falls inside replaced text, or the element that follows is not the one that was there.
 */
export function relocateTag(tag: string, before: string, after: string, spans: readonly Span[]): string | null {
  const match = TAG.exec(tag);
  if (!match) return null;
  const file = match[1]!;
  const offset = offsetOf(before, Number(match[2]), Number(match[3]));
  if (offset === null) return null;
  const name = tagNameAt(before, offset);
  if (!name) return null;
  const moved = mapOffset(offset, spans);
  if (moved === null || tagNameAt(after, moved) !== name) return null;
  const { line, column } = lineColumnOf(after, moved);
  return `${file}:${line}:${column}`;
}

/** The file part of a source tag. */
export const tagFile = (tag: string): string | null => TAG.exec(tag)?.[1] ?? null;
