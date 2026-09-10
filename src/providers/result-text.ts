/**
 * Turning a provider's tool result into text a server can actually receive.
 *
 * Two constraints, both learned the hard way:
 *
 *  - The server's WebSocket cap is on BYTES. An oversized frame is not merely
 *    dropped: Ratchet answers it with a CLOSE_TOO_BIG and the connection is
 *    torn down, taking every other in-flight request on that bridge with it.
 *    So the bound has to be measured in the units the cap is written in.
 *
 *  - `JSON.parse` is iterative and accepts essentially unbounded nesting;
 *    `JSON.stringify` is recursive and throws around 5,000 levels. A line the
 *    adapter has already accepted can therefore blow up while being encoded,
 *    inside the readline listener, where an uncaught throw takes down the
 *    daemon rather than failing one request.
 */

/**
 * Budget for a single result, measured as the bytes it costs once JSON-encoded.
 *
 * Deliberately well under the server's 1MB frame cap: the envelope adds little,
 * but leaving half the budget spare means no plausible encoding surprise gets
 * near the ceiling.
 */
export const MAX_RESULT_BYTES = 256 * 1024;

/** What one string costs on the wire once JSON-encoded. */
function encodedBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), 'utf8');
}

/**
 * Trim to a boundary that does not split a surrogate pair.
 *
 * A lone high surrogate would matter: `JSON.stringify` escapes it to a literal
 * `\ud83d`, so the frame is valid UTF-8 and looks fine here, and then PHP's
 * `json_decode` rejects the WHOLE message with "Single unpaired UTF-16
 * surrogate" — the result is lost behind a protocol error pointing nowhere
 * near the size.
 *
 * Belt and braces, and worth being honest about: the search below cannot
 * currently choose such a cut. The escape costs six bytes where the intact pair
 * costs four, so a split is always more expensive than keeping the pair and
 * never fits where the pair did not. Measured — removing this guard changes no
 * output. It stays because that reasoning is a property of the search, and the
 * next person to change the search should not have to rediscover it.
 */
function sliceWholeCharacters(text: string, end: number): string {
  const code = text.charCodeAt(end - 1);
  const splitsAPair = code >= 0xd800 && code <= 0xdbff;

  return text.slice(0, splitsAPair ? end - 1 : end);
}

/**
 * Bound a result to what the wire can carry, saying so rather than losing the
 * tail silently.
 *
 * The marker is inside the budget, not added after it.
 */
export function boundResult(text: string): string {
  return boundText(text, MAX_RESULT_BYTES, encodedBytes);
}

/**
 * Bound text that is itself a tool call's arguments.
 *
 * Measured in RAW bytes, because that is the unit every consumer uses for this
 * budget — `strlen` on the recorded JSON, `TextEncoder` in the component. A
 * result is different: it travels as a JSON string INSIDE the frame, so the
 * escaped size is what counts against the frame cap.
 *
 * Getting that backwards silently spent the ceiling on escaping: a real `Write`
 * full of quotes and newlines kept only 62% of what it was allowed. It is the
 * same unit mistake made once for boundArguments, on the sibling path, when
 * this stopped being boundResult.
 */
export function boundArgumentText(text: string): string {
  return boundText(text, MAX_ARGUMENT_BYTES, (t) => Buffer.byteLength(t, 'utf8'));
}

function boundText(text: string, budget: number, measure: (text: string) => number): string {
  return boundWellFormed(replaceLoneSurrogates(text), budget, measure);
}

/**
 * Replace any unpaired surrogate with U+FFFD.
 *
 * A lone surrogate anywhere — not only at a cut — makes PHP's `json_decode`
 * reject the ENTIRE message, so the turn is lost behind a protocol error
 * pointing nowhere near the cause. One can arrive in the input itself: a CLI
 * line containing `"\ud83d"` parses to exactly that. Replacing it costs one
 * unrenderable character; not replacing it costs the message.
 *
 * Written out rather than using `String.prototype.toWellFormed`, which is
 * ES2024 and beyond this project's lib target. The common case — no lone
 * surrogate — allocates nothing.
 */
export function replaceLoneSurrogates(text: string): string {
  // Spans, not per-character strings: rebuilding one string per code unit cost
  // 300ms and 20MB on a large input, inside the readline listener this file's
  // header says must not block.
  let pieces: string[] | null = null;
  let copiedTo = 0;

  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (!isHigh && !isLow) continue;

    if (isHigh && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1; // a well-formed pair
        continue;
      }
    }

    if (pieces === null) pieces = [];
    pieces.push(text.slice(copiedTo, i), '\ufffd');
    copiedTo = i + 1;
  }

  if (pieces === null) return text;
  pieces.push(text.slice(copiedTo));

  return pieces.join('');
}

function boundWellFormed(text: string, budget: number, measure: (text: string) => number): string {
  if (measure(text) <= budget) return text;

  const markerFor = (shown: number): string =>
    `\n…[truncated by the bridge: showing ${shown} of ${text.length} characters]`;

  // Binary search the longest prefix that still fits with its marker. Character
  // cost varies by more than 6× once JSON escaping is applied — a control
  // character is one code unit and six encoded bytes — so a fixed ratio would
  // be wrong in one direction or the other for most real content.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = sliceWholeCharacters(text, mid);
    if (measure(candidate + markerFor(candidate.length)) <= budget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  const kept = sliceWholeCharacters(text, low);

  return kept + markerFor(kept.length);
}

/**
 * JSON-encode a value that came from `JSON.parse`, without the encode being
 * able to kill the process. See the note about nesting depth above.
 */
export function safeStringify(value: unknown, fallback: string): string {
  try {
    return JSON.stringify(value) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Replace unpaired surrogate ESCAPES in already-encoded JSON.
 *
 * `replaceLoneSurrogates` works on text; by the time a value has been through
 * `JSON.stringify` a lone surrogate is the six ordinary ASCII characters
 * `\ud83d`, which that function correctly sees nothing wrong with. PHP's
 * `json_decode` does not agree — it rejects the value outright with "Single
 * unpaired UTF-16 surrogate" — so the argument JSON has to be cleaned after
 * encoding, not before.
 */
export function replaceLoneSurrogateEscapes(json: string): string {
  // The common case has no surrogate escapes at all and does no work.
  if (!/\\u[dD][89abAB]/.test(json) && !/\\u[dD][c-fC-F]/.test(json)) return json;

  let out: string[] | null = null;
  let copiedTo = 0;
  let i = 0;

  while (i < json.length) {
    if (json[i] !== '\\') {
      i += 1;
      continue;
    }

    // Backslash PARITY. `\\ud83d` is an escaped backslash followed by the
    // letter u — a literal, not an escape — and treating it as one silently
    // rewrote real text: any Write or Edit whose content discusses surrogates,
    // including this file. A regex that matches `\u` wherever it appears
    // cannot tell the two apart.
    let run = i;
    while (run < json.length && json[run] === '\\') run += 1;
    const backslashes = run - i;

    if (backslashes % 2 === 0) {
      i = run;
      continue;
    }

    // The final backslash opens an escape at run - 1.
    const escapeAt = run - 1;
    const seq = json.slice(escapeAt, escapeAt + 6);
    const high = /^\\u[dD][89abAB][0-9a-fA-F]{2}$/.test(seq);
    const low = /^\\u[dD][c-fC-F][0-9a-fA-F]{2}$/.test(seq);

    if (!high && !low) {
      i = run;
      continue;
    }

    if (high) {
      const next = json.slice(escapeAt + 6, escapeAt + 12);
      if (/^\\u[dD][c-fC-F][0-9a-fA-F]{2}$/.test(next)) {
        i = escapeAt + 12; // a well-formed pair
        continue;
      }
    }

    if (out === null) out = [];
    out.push(json.slice(copiedTo, escapeAt), '\\ufffd');
    copiedTo = escapeAt + 6;
    i = copiedTo;
  }

  if (out === null) return json;
  out.push(json.slice(copiedTo));

  return out.join('');
}

/**
 * Ceiling on a tool call's arguments.
 *
 * ONE number, matching the recorder's own cap on the far side. They used to
 * differ — 256KB here, 64KB there — so everything in between was emitted whole
 * and then byte-cut by the consumer into JSON that no longer parsed, losing
 * every argument including the small ones. Two caps in different places is the
 * same mistake as two implementations of one rule.
 */
export const MAX_ARGUMENT_BYTES = 64 * 1024;

/** How much of an oversized value to keep as a sample. */
const HEAD_CHARS = 200;

/** What a value costs once encoded. */
function valueBytes(value: unknown): number {
  return Buffer.byteLength(safeStringify(value, '""'), 'utf8');
}

/**
 * Cut to a length that does not split a surrogate pair.
 *
 * Belt and braces since `replaceLoneSurrogateEscapes` runs over the encoded
 * output and would clean up a split anyway — measured: removing this guard
 * changes no output. It stays because cutting a character in half to then
 * repair it is a worse way to arrive at the same place, and the repair is not
 * this function's to rely on.
 */
function headOf(text: string): string {
  const end = text.length <= HEAD_CHARS ? text.length : HEAD_CHARS;
  const code = text.charCodeAt(end - 1);
  const splitsAPair = code >= 0xd800 && code <= 0xdbff;

  return text.slice(0, splitsAPair ? end - 1 : end);
}

/** The stand-in for a value too large to carry. */
function marker(value: unknown): Record<string, unknown> {
  return {
    __truncated__: {
      bytes: valueBytes(value),
      ...(typeof value === 'string' ? { head: headOf(value) } : {}),
    },
  };
}

/**
 * Shrink one value to fit a budget, keeping as much shape as possible.
 *
 * Recurses one level into an object or array, so a big `content` beside a small
 * `meta` costs only the `content` — replacing the whole subtree, which an
 * earlier version did, threw away siblings that would have fitted easily.
 */
function shrinkValue(value: unknown, budget: number, depth: number): unknown {
  if (valueBytes(value) <= budget) return value;
  if (depth <= 0 || typeof value !== 'object' || value === null) return marker(value);

  const entries: [string | number, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [i, v])
    : Object.entries(value as Record<string, unknown>);

  const shrunk = shrinkEntries(entries, budget, depth - 1);
  if (shrunk === null) return marker(value);

  return Array.isArray(value)
    ? shrunk.map(([, v]) => v)
    : Object.fromEntries(shrunk);
}

/**
 * Fit a set of entries into a budget, largest value first.
 *
 * Sizes are measured ONCE per entry and the running total is adjusted as values
 * are replaced. Re-encoding the whole object on every iteration — which is what
 * this did first — is quadratic: measured at 32 seconds for four thousand keys
 * and tens of minutes for twenty thousand, synchronously, in the readline
 * listener this file's header says must not block. A torn connection
 * reconnects; a stalled event loop does not.
 *
 * Returns null when even the keys alone cannot fit.
 */
function shrinkEntries(
  entries: [string | number, unknown][],
  budget: number,
  depth: number,
): [string, unknown][] | null {
  const sized = entries.map(([key, value]) => ({
    key: String(key),
    value,
    bytes: valueBytes(value) + Buffer.byteLength(String(key), 'utf8') + 4,
  }));

  let total = sized.reduce((sum, e) => sum + e.bytes, 2);
  const replaced = new Map<string, unknown>();

  for (const entry of [...sized].sort((a, b) => b.bytes - a.bytes)) {
    if (total <= budget) break;

    const shrunkValue = shrinkValue(entry.value, Math.max(budget - (total - entry.bytes), 0), depth);
    const shrunkBytes = valueBytes(shrunkValue) + Buffer.byteLength(entry.key, 'utf8') + 4;
    // Replacing many small values with markers makes the object BIGGER, which
    // is how the first version looped over every key and still did not fit.
    if (shrunkBytes >= entry.bytes) continue;

    replaced.set(entry.key, shrunkValue);
    total -= entry.bytes - shrunkBytes;
  }

  if (total <= budget) {
    return sized.map((e) => [e.key, replaced.has(e.key) ? replaced.get(e.key) : e.value]);
  }

  // Breadth, not size: thousands of small arguments, none worth replacing.
  // Keep the ones that fit and say how many did not, rather than returning
  // nothing — which is what the first version did after all that work.
  const kept: [string, unknown][] = [];
  let used = 2;
  for (const entry of sized) {
    const value = replaced.has(entry.key) ? replaced.get(entry.key) : entry.value;
    const bytes = valueBytes(value) + Buffer.byteLength(entry.key, 'utf8') + 4;
    if (used + bytes > budget - 80) break;
    kept.push([entry.key, value]);
    used += bytes;
  }

  if (kept.length === 0) return null;

  // A key the input does not already use. Writing `__truncated__` blindly
  // overwrote a genuine argument of that name — a sentinel that can appear in
  // the data, which is the same mistake as reading failure out of an `Error:`
  // prefix, and one this file argues against elsewhere.
  const taken = new Set(sized.map((e) => e.key));
  let notice = '__truncated__';
  for (let n = 2; taken.has(notice); n += 1) notice = `__truncated_${n}__`;

  kept.push([notice, { omitted: sized.length - kept.length }]);

  return kept;
}

/**
 * Bound a tool call's ARGUMENTS, keeping them valid JSON.
 *
 * Truncating the encoded string — which is what this used to do — is wrong in a
 * way that is worse than the size problem it solved. The marker lands inside a
 * JSON object, so the whole thing stops parsing, and a consumer then records
 * "arguments could not be parsed" and loses ALL of them: a `Write` call's
 * `file_path` is twenty bytes and the single most useful field for anyone
 * auditing what happened, discarded because `content` was large.
 *
 * So the structure is bounded instead of the text. Every key survives that can;
 * only the values too big to carry are replaced, by an object saying what was
 * there. The result is still valid JSON, still has `file_path`, and still says
 * plainly that something was cut.
 */
export function boundArguments(value: unknown): string {
  // Distinguished from `{}`. safeStringify's fallback is "{}", which is under
  // the cap and returned verbatim — so a value JSON.stringify cannot encode
  // (this file's own header notes it throws around 5,000 levels of nesting,
  // where JSON.parse accepts far more) recorded as "called with no arguments".
  // A deeply nested SIBLING would take file_path down with it, which is the one
  // field the whole structural bound exists to preserve.
  let raw: string | undefined;
  try {
    raw = JSON.stringify(value);
  } catch {
    raw = undefined;
  }
  if (raw === undefined) {
    return JSON.stringify({ __truncated__: { reason: 'arguments could not be encoded' } });
  }

  const encoded = replaceLoneSurrogateEscapes(raw);
  // RAW bytes, not the escaped size the frame carries. This string is the
  // argument JSON itself, and it is the raw length the consumer stores and caps
  // at the same number. Measuring the escaped form here — which is what the
  // first version did — compares a budget built in one unit against a total
  // measured in another, roughly double, so a correct answer looks oversized
  // and is thrown away.
  if (Buffer.byteLength(encoded, 'utf8') <= MAX_ARGUMENT_BYTES) return encoded;

  const shrunk = shrinkValue(value, MAX_ARGUMENT_BYTES, 2);
  const out = replaceLoneSurrogateEscapes(safeStringify(shrunk, '{}'));

  // A last resort that is still parseable, rather than a prefix that is not.
  return Buffer.byteLength(out, 'utf8') <= MAX_ARGUMENT_BYTES
    ? out
    : safeStringify({ __truncated__: { bytes: Buffer.byteLength(encoded, 'utf8') } }, '{}');
}
