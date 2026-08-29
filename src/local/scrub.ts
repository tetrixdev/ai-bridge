/**
 * Redaction of secret values from tool output.
 *
 * This is hygiene, not containment, and the difference matters when writing
 * anything that describes it. It turns the ACCIDENTAL case from "the model was
 * asked not to print the password" into "the model cannot", and it catches the
 * likelier leak, which is a tool printing a connection string in an error
 * message through nobody's fault.
 *
 * It does not survive `| base64`, `| rev`, writing to a file, or curling the
 * value somewhere. Anything deliberate defeats it in one word. Nothing
 * accidental does any of those things.
 */

export interface Redaction {
  name: string;
  value: string;
}

/**
 * Replace every occurrence of each secret with a marker naming which one it
 * was, so a person reading the transcript can tell a redaction from a bug.
 *
 * Longest first: if one secret's value is a substring of another's, replacing
 * the shorter one first would leave the longer one partially rewritten and
 * therefore no longer matchable, so a fragment of it would survive.
 */
export function scrub(text: string, secrets: Redaction[]): string {
  let out = text;
  const ordered = [...secrets]
    // A very short value would match everywhere and redact the whole output
    // into noise, which is worse than not redacting: it hides the real result
    // while teaching nobody anything.
    .filter((s) => s.value.length >= 4)
    .sort((a, b) => b.value.length - a.value.length);

  for (const s of ordered) {
    out = out.split(s.value).join(`[redacted: ${s.name}]`);
  }
  return out;
}
