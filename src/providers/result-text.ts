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
  return boundWellFormed(replaceLoneSurrogates(text));
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
  let rebuilt: string[] | null = null;

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

    if (rebuilt === null) rebuilt = Array.from({ length: text.length }, (_, n) => text[n] as string);
    rebuilt[i] = '\ufffd';
  }

  return rebuilt === null ? text : rebuilt.join('');
}

function boundWellFormed(text: string): string {
  if (encodedBytes(text) <= MAX_RESULT_BYTES) return text;

  const marker = (shown: number): string =>
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
    if (encodedBytes(candidate + marker(candidate.length)) <= MAX_RESULT_BYTES) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  const kept = sliceWholeCharacters(text, low);

  return kept + marker(kept.length);
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
