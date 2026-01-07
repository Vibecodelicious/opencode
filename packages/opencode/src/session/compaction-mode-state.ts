/**
 * Runtime state for compaction mode per session.
 *
 * This module provides lightweight, in-memory state management for the
 * compactionModeEnabled flag. This flag determines whether message IDs
 * are visible to the LLM in the conversation context.
 *
 * ## Design Decisions
 *
 * **Why runtime state instead of persisted storage?**
 * The compactionModeEnabled flag is transient - it only matters during an
 * active two-phase compaction flow. If the process restarts, starting fresh
 * with IDs hidden is the correct behavior because:
 * 1. The LLM loses its context anyway on restart
 * 2. The prepare mode response wouldn't be in the new context
 * 3. It's safer to default to hiding IDs
 *
 * ## Session Lifecycle Cleanup
 *
 * TODO: When session cleanup/disposal is implemented, it should call
 * `CompactionModeState.clear(sessionID)` to prevent orphaned entries.
 * This is especially important for agent swarms/teams where many
 * concurrent sessions may enter prepare mode but crash or abandon
 * before completing the two-phase flow.
 *
 * ## Two-Phase Compaction Flow
 *
 * Phase 1 (Prepare Mode):
 * 1. LLM calls compact({ ranges: [] }) with empty ranges
 * 2. Compact tool sets compactionModeEnabled = true via this module
 * 3. Tool returns instructions for LLM
 * 4. Next context rebuild includes message ID prefixes
 *
 * Phase 2 (Execute Mode):
 * 5. LLM sees visible IDs, identifies ranges to compact
 * 6. LLM calls compact({ ranges: [...] }) with actual ranges
 * 7. After successful archival, tool resets compactionModeEnabled = false
 * 8. Subsequent context rebuilds hide IDs again
 */
export namespace CompactionModeState {
  /**
   * In-memory storage for compaction mode state per session.
   * Maps sessionID -> compactionModeEnabled flag.
   */
  const state = new Map<string, boolean>()

  /**
   * Gets the compactionModeEnabled flag for a session.
   *
   * @param sessionID - The session to check
   * @returns true if compaction mode is enabled, false otherwise (default)
   */
  export function get(sessionID: string): boolean {
    return state.get(sessionID) ?? false
  }

  /**
   * Sets the compactionModeEnabled flag for a session.
   *
   * @param sessionID - The session to update
   * @param enabled - Whether compaction mode should be enabled
   */
  export function set(sessionID: string, enabled: boolean): void {
    if (enabled) {
      state.set(sessionID, true)
    } else {
      // Clean up by removing the entry when disabled
      state.delete(sessionID)
    }
  }

  /**
   * Clears the compaction mode state for a specific session.
   * Equivalent to set(sessionID, false).
   *
   * @param sessionID - The session to clear
   */
  export function clear(sessionID: string): void {
    state.delete(sessionID)
  }

  /**
   * Resets all compaction mode state across all sessions.
   * Primarily used for testing.
   */
  export function reset(): void {
    state.clear()
  }
}
