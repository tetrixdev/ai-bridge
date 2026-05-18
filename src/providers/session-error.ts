/**
 * Classification of provider errors that occur while resuming a CLI session.
 */

/**
 * Decide which error code an adapter should emit for a provider error.
 *
 * When a turn supplied a `cliSessionId` to resume and the CLI then failed
 * because that session no longer exists, the failure is *recoverable*: the
 * adapter emits `session_lost`, which tells the server to wipe the stored id
 * and silently re-issue the turn as a fresh session. Any other error — and
 * every error on a fresh (non-resume) turn — is a plain `provider_error` that
 * surfaces to the user.
 *
 * The CLIs phrase a missing session differently (claude: "No conversation
 * found with session ID …", codex: thread not found, gemini: session/resume
 * errors), so the match is deliberately broad. A misclassification only costs
 * a visible error instead of a silent retry — it never causes a hang.
 *
 * @param cliSessionId  The session the turn tried to resume, or null if fresh.
 * @param message       The provider's error message.
 */
export function resumeAwareErrorCode(
  cliSessionId: string | null,
  message: string,
): 'session_lost' | 'provider_error' {
  if (cliSessionId === null) {
    return 'provider_error';
  }

  const looksLikeLostSession =
    /(not found|no conversation|no such|cannot resume|could not resume|invalid session|unknown session|session.*expired|expired session)/i.test(
      message,
    );

  return looksLikeLostSession ? 'session_lost' : 'provider_error';
}
