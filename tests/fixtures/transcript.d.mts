/** Types for the transcript fixture. The implementation lives in transcript.mjs. */

export interface TranscriptSubagent {
  /** Contents of agent-<agentId>.meta.json. */
  meta: object
  lines: object[]
}

/** `cwd` with everything but ASCII letters and digits replaced by `-`. */
export declare function encodeProjectDir(cwd: string): string

/**
 * Writes the session file where the CLI keeps it, plus each subagent's file
 * and meta under `<sessionId>/subagents/`; returns the session file's path.
 */
export declare function writeTranscript(
  configDir: string,
  cwd: string,
  sessionId: string,
  lines: object[],
  subagents?: Record<string, TranscriptSubagent>
): string

/** A finished session with subagents, a compaction and a rewound branch. */
export declare function resumedSession(
  sessionId: string,
  cwd: string
): { lines: object[]; subagents: Record<string, TranscriptSubagent> }
