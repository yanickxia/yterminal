export type OutputSequenceResult =
  | { kind: "duplicate" }
  | { kind: "gap"; expected: number; actual: number }
  | { kind: "data"; data: Uint8Array; start: number; end: number };

/**
 * Reconcile one agent output chunk against the next byte sequence expected by
 * xterm. Full duplicates are dropped, partial overlaps are trimmed, and gaps
 * are explicit so the caller can request replay from its parsed checkpoint.
 */
export function acceptOutputSequence(
  nextSeq: number,
  startSeq: number,
  data: Uint8Array
): OutputSequenceResult {
  let start = startSeq;
  let accepted = data;
  if (start < nextSeq) {
    const duplicate = nextSeq - start;
    if (duplicate >= accepted.length) return { kind: "duplicate" };
    accepted = accepted.subarray(duplicate);
    start = nextSeq;
  }
  if (start > nextSeq) {
    return { kind: "gap", expected: nextSeq, actual: start };
  }
  return {
    kind: "data",
    data: accepted,
    start,
    end: start + accepted.length,
  };
}
