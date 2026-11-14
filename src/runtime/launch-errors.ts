/**
 * Stable marker in persisted launch events. Keep the value after retiring the
 * original runtime so reap continues classifying historical failures correctly.
 */
export const UID_DROP_PREFLIGHT_ERROR_PREFIX = "agent-entrypoint: uid-drop preflight failed";
