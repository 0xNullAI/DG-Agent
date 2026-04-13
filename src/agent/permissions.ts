/**
 * permissions.ts — Permission state for AI-initiated tool calls.
 *
 * Two independent layers are maintained here:
 *
 *   1. Per-tool grant cache (for the "每次询问" mode dialog)
 *      A Map<toolName, {until}> holding the user's decision from the modal
 *      dialog. Populated by `recordChoice` when the user picks one of:
 *        - once   : leave no grant, ask again next call
 *        - timed  : grant until now + 5 minutes
 *        - always : grant for the rest of the session (Infinity)
 *        - deny   : no grant, reject this single call
 *      Read by `hasGrant` with lazy expiry.
 *
 *   2. Settings-level global mode ('ask' | 'timed' | 'always')
 *      Governs whether the dialog shows up at all. 'ask' uses layer 1;
 *      'timed' auto-allows on a wall-clock 5-minute window persisted in
 *      localStorage; 'always' is an in-memory-only override that wipes
 *      on page reload or `clearAlwaysMode()`.
 *
 * Nothing here is persisted beyond what localStorage already carries for
 * the settings layer — the per-tool cache lives entirely in memory so a
 * page refresh always resets trust. That is a safety property for a
 * physical-device control surface, not an oversight.
 */

import type { PermissionMode } from '../types';
import { isMutatingTool } from './policies';
import { loadSettings, saveSettings } from './providers';

export type PermissionChoice = 'once' | 'timed' | 'always' | 'deny';

/** Window used by both the dialog's 'timed' scope and the settings-level 'timed' mode. */
export const TIMED_GRANT_MS = 5 * 60 * 1000;

interface Grant {
  /** Expiry epoch millis; Number.POSITIVE_INFINITY means session-wide. */
  until: number;
}

const grants = new Map<string, Grant>();

/** True if the given tool name needs to pass the permission gate at all. */
export function requiresPermission(toolName: string): boolean {
  return isMutatingTool(toolName);
}

/** True if a live grant already exists for this tool (and has not expired). */
export function hasGrant(toolName: string): boolean {
  const g = grants.get(toolName);
  if (!g) return false;
  if (Date.now() > g.until) {
    grants.delete(toolName);
    return false;
  }
  return true;
}

/**
 * Apply the user's choice to the grant store.
 * Returns the effective decision ('allow' or 'deny') that the caller should
 * act on for the current call.
 */
export function recordChoice(toolName: string, choice: PermissionChoice): 'allow' | 'deny' {
  if (choice === 'deny') return 'deny';
  if (choice === 'timed') {
    grants.set(toolName, { until: Date.now() + TIMED_GRANT_MS });
  } else if (choice === 'always') {
    grants.set(toolName, { until: Number.POSITIVE_INFINITY });
  }
  // 'once' leaves no grant behind — next call will prompt again.
  return 'allow';
}

/** Wipe every grant. Useful for tests and for a future "reset permissions" UI. */
export function clearGrants(): void {
  grants.clear();
}

// ---------------------------------------------------------------------------
// Settings-level permission mode
// ---------------------------------------------------------------------------

/**
 * In-memory override for the 'always' mode.
 *
 * 'always' is deliberately NOT persisted to localStorage — it only lives as
 * long as the current JS module instance. This means:
 *   - A page refresh resets it to false (module re-executes from scratch)
 *   - Starting a new conversation can reset it via clearAlwaysMode()
 *   - Opening a new tab starts fresh
 *
 * The persisted setting only ever holds 'ask' or 'timed'. When the user
 * picks 'always' in settings we flip this flag and persist 'ask' as the
 * fallback — so after any refresh, the effective mode is 'ask' again.
 */
let sessionAlwaysMode = false;

/**
 * Return the currently effective permission mode.
 *
 * The in-memory 'always' override wins over anything persisted; otherwise
 * reads the persisted setting and self-heals an expired 'timed' window
 * (normalizing to 'ask' and saving) so stale timers don't leak into behavior.
 */
export function getEffectiveMode(): PermissionMode {
  if (sessionAlwaysMode) return 'always';
  const s = loadSettings();
  const mode = s.permissionMode || 'ask';
  if (mode === 'timed') {
    if (typeof s.permissionModeExpiresAt !== 'number' || Date.now() >= s.permissionModeExpiresAt) {
      const next = { ...s, permissionMode: 'ask' as PermissionMode };
      delete next.permissionModeExpiresAt;
      saveSettings(next);
      return 'ask';
    }
  }
  return mode;
}

/**
 * Set the permission mode. 'ask' and 'timed' are persisted; 'always' is
 * kept only in memory (see `sessionAlwaysMode` comment above).
 */
export function setMode(mode: PermissionMode): void {
  if (mode === 'always') {
    sessionAlwaysMode = true;
    // Persist 'ask' as the durable fallback so a page refresh reverts.
    const s = loadSettings();
    s.permissionMode = 'ask';
    delete s.permissionModeExpiresAt;
    saveSettings(s);
    return;
  }

  sessionAlwaysMode = false;
  const s = loadSettings();
  s.permissionMode = mode;
  if (mode === 'timed') {
    s.permissionModeExpiresAt = Date.now() + TIMED_GRANT_MS;
  } else {
    delete s.permissionModeExpiresAt;
  }
  saveSettings(s);
}

/**
 * Revoke the in-memory 'always' override. Called when starting a new
 * conversation so previously granted session-wide trust doesn't carry
 * into a fresh context.
 */
export function clearAlwaysMode(): void {
  sessionAlwaysMode = false;
}

/**
 * Remaining ms on the current 'timed' window. Returns 0 when not in timed
 * mode or the window has already expired.
 */
export function getTimedRemainingMs(): number {
  const s = loadSettings();
  if (s.permissionMode !== 'timed' || typeof s.permissionModeExpiresAt !== 'number') {
    return 0;
  }
  return Math.max(0, s.permissionModeExpiresAt - Date.now());
}
