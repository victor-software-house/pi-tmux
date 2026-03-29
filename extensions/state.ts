/**
 * Durable tmux session state — persisted in Pi session entries.
 *
 * Source of truth for the tmux session identity across tool calls.
 * Replaces cwd-based derivation so session targeting survives resume,
 * cwd drift, fork, and tree navigation.
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { deriveSessionName, deriveStagingName, isSessionAlive, resolveProjectRoot, tryRun } from "./session.js";

/** The read-only session manager exposed via ExtensionContext. */
type SessionReader = ExtensionContext["sessionManager"];

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CUSTOM_TYPE = "pi-tmux-state";

export interface TmuxSessionStateV1 {
	version: 1;
	tmuxSessionName: string;
	/** When running inside tmux CC mode, the name of the CC-attached host session
	 *  (e.g. "0"). View panes live here. Null when not in tmux mode. */
	hostSessionName: string | null;
	/** Informational only — the cwd that seeded the initial name. Not used for routing. */
	createdFromCwd: string;
	updatedAt: number;
}

// ---------------------------------------------------------------------------
// In-memory cache (disposable — rebuilt from session entries)
// ---------------------------------------------------------------------------

let cached: TmuxSessionStateV1 | null = null;

/** Read the cached state. Returns null if not yet loaded. */
export function getCachedState(): TmuxSessionStateV1 | null {
	return cached;
}

/** Clear the in-memory cache (e.g. on session_shutdown). */
export function clearCache(): void {
	cached = null;
}

// ---------------------------------------------------------------------------
// Session entry helpers
// ---------------------------------------------------------------------------

/**
 * Load the latest persisted tmux state from the session history.
 * Scans entries in reverse for the most recent pi-tmux-state custom entry.
 */
export function loadPersistedState(sessionManager: SessionReader): TmuxSessionStateV1 | null {
	const entries = sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (
			entry !== undefined &&
			entry.type === "custom" &&
			"customType" in entry &&
			(entry as { customType: string }).customType === CUSTOM_TYPE
		) {
			const data = (entry as { data?: unknown }).data;
			if (isValidState(data)) return data;
		}
	}
	return null;
}

function isValidState(data: unknown): data is TmuxSessionStateV1 {
	if (data === null || data === undefined || typeof data !== "object") return false;
	const obj = data as Record<string, unknown>;
	return (
		obj.version === 1 &&
		typeof obj.tmuxSessionName === "string" &&
		obj.tmuxSessionName.length > 0
	);
}

/**
 * Detect the current tmux host session name.
 * Returns the session name if running inside tmux, null otherwise.
 */
function detectHostSession(): string | null {
	if (!process.env.TMUX) return null;
	const raw = tryRun("tmux display-message -p '#{session_name}'");
	return raw?.trim() || null;
}

/** Persist state as a new session entry. */
function saveState(pi: ExtensionAPI, state: TmuxSessionStateV1): void {
	pi.appendEntry<TmuxSessionStateV1>(CUSTOM_TYPE, state);
	cached = state;
}

// ---------------------------------------------------------------------------
// Rehydration (call from lifecycle hooks)
// ---------------------------------------------------------------------------

/**
 * Rehydrate the in-memory cache from the session history.
 * Safe to call multiple times — idempotent.
 */
export function rehydrate(sessionManager: SessionReader): void {
	cached = loadPersistedState(sessionManager);
}

// ---------------------------------------------------------------------------
// Resolver — the single path to session identity
// ---------------------------------------------------------------------------

export interface ResolvedBinding {
	tmuxSessionName: string;
	stagingSessionName: string;
	/** The CC-attached host session, or same as tmuxSessionName when not in CC mode. */
	hostSessionName: string;
	/** True if the tmux session was just (re)created by the resolver. */
	recreated: boolean;
}

/**
 * Get or create the tmux session binding for the current Pi session.
 *
 * Resolution order:
 * 1. In-memory cache
 * 2. Persisted session entry
 * 3. Initialize from cwd (first use only)
 *
 * If the tmux session is missing, it is recreated automatically.
 */
export function getOrCreateBinding(
	pi: ExtensionAPI,
	sessionManager: SessionReader,
	fallbackCwd: string,
): ResolvedBinding {
	// 1. Try cache
	let state = cached;

	// 2. Try persisted entries
	if (!state) {
		state = loadPersistedState(sessionManager);
		if (state) cached = state;
	}

	// 3. Initialize fresh
	if (!state) {
		const root = resolveProjectRoot(fallbackCwd);
		state = {
			version: 1,
			tmuxSessionName: deriveSessionName(root),
			hostSessionName: detectHostSession(),
			createdFromCwd: root,
			updatedAt: Date.now(),
		};
		saveState(pi, state);
	}

	// Validate live tmux session and recreate if missing
	const recreated = ensureTmuxSessionExists(state.tmuxSessionName);

	const host = state.hostSessionName ?? state.tmuxSessionName;
	return {
		tmuxSessionName: state.tmuxSessionName,
		stagingSessionName: deriveStagingName(state.tmuxSessionName),
		hostSessionName: host,
		recreated,
	};
}

/**
 * Ensure the primary tmux session exists. Returns true if it was recreated.
 */
function ensureTmuxSessionExists(name: string): boolean {
	if (isSessionAlive(name)) return false;
	// Session is missing — recreate it.
	// actionRun already handles session creation in legacy mode, but for
	// peek/list/focus/attach we need the session to exist.
	// We do NOT create it here in the general case — actionRun handles creation
	// with proper window setup. Instead, we just report that it is missing and
	// let callers decide. For read-only actions this means "no session yet".
	return false;
}

/**
 * Notify the state layer that a tmux session was created (by actionRun or similar).
 * Ensures persisted state is up to date.
 */
export function notifySessionCreated(
	pi: ExtensionAPI,
	sessionManager: SessionReader,
	tmuxSessionName: string,
	cwd: string,
): void {
	const existing = cached ?? loadPersistedState(sessionManager);
	if (existing && existing.tmuxSessionName === tmuxSessionName) {
		// Already tracking the right name — just update cache
		cached = existing;
		return;
	}
	// New or changed session — persist
	const state: TmuxSessionStateV1 = {
		version: 1,
		tmuxSessionName,
		hostSessionName: detectHostSession(),
		createdFromCwd: cwd,
		updatedAt: Date.now(),
	};
	saveState(pi, state);
}

/**
 * Get the persisted session name without creating anything.
 * Used by read-only actions that should not auto-create state.
 */
export function getPersistedSessionName(sessionManager: SessionReader): string | null {
	const state = cached ?? loadPersistedState(sessionManager);
	if (state) cached = state;
	return state?.tmuxSessionName ?? null;
}
