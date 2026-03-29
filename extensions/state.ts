/**
 * Durable tmux session state — persisted in Pi session entries.
 *
 * Source of truth for the tmux session identity across tool calls.
 * Replaces cwd-based derivation so session targeting survives resume,
 * cwd drift, fork, and tree navigation.
 *
 * Static fields (tmuxSessionName, createdFromCwd) are persisted.
 * Dynamic fields (hostSessionName) are detected once per pi session
 * and cached in-memory — never persisted (they go stale across sessions).
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { deriveSessionName, deriveStagingName, isSessionAlive, resolveProjectRoot, tryRun } from "./session.js";

/** The read-only session manager exposed via ExtensionContext. */
type SessionReader = ExtensionContext["sessionManager"];

// ---------------------------------------------------------------------------
// Schema — persisted fields only
// ---------------------------------------------------------------------------

const CUSTOM_TYPE = "pi-tmux-state";

export interface TmuxSessionStateV1 {
	version: 1;
	tmuxSessionName: string;
	/** Informational only — the cwd that seeded the initial name. Not used for routing. */
	createdFromCwd: string;
	updatedAt: number;
}

// ---------------------------------------------------------------------------
// In-memory cache (disposable — rebuilt from session entries + live detection)
// ---------------------------------------------------------------------------

let cached: TmuxSessionStateV1 | null = null;

/** Host session name, detected once and cached for the lifetime of this pi session. */
let cachedHostSession: string | null | undefined = undefined; // undefined = not yet detected
/** Host window index, detected once from TMUX_PANE. */
let cachedHostWindowIndex: number | undefined = undefined;
/** Number of failed host detection attempts. */
let hostDetectFailures = 0;
const MAX_HOST_DETECT_RETRIES = 3;

/** Read the cached state. Returns null if not yet loaded. */
export function getCachedState(): TmuxSessionStateV1 | null {
	return cached;
}

/** Clear the in-memory cache (e.g. on session_shutdown). */
export function clearCache(): void {
	cached = null;
	cachedHostSession = undefined;
	cachedHostWindowIndex = undefined;
	hostDetectFailures = 0;
}

// ---------------------------------------------------------------------------
// Host session detection — once per pi session
// ---------------------------------------------------------------------------

/**
 * Detect the current tmux host session name.
 * Cached after first call — the CC session name is stable within a pi session.
 */
/**
 * Detect and cache the tmux host session name.
 * Called once on session start / rehydrate. On failure, retries up to
 * MAX_HOST_DETECT_RETRIES times before giving up.
 */
function getHostSession(): string | null {
	if (cachedHostSession !== undefined) return cachedHostSession;
	if (!process.env.TMUX) {
		cachedHostSession = null;
		return null;
	}
	if (hostDetectFailures >= MAX_HOST_DETECT_RETRIES) {
		return null;
	}
	// TMUX_PANE is the source of truth for Pi's own tmux location.
	const paneId = process.env.TMUX_PANE;
	if (paneId) {
		const raw = tryRun(`tmux display -p -t ${paneId} "#{session_name}\t#{window_index}"`);
		if (raw) {
			const parts = raw.trim().split("\t");
			const name = parts[0] ?? "";
			const winIdx = Number.parseInt(parts[1] ?? "", 10);
			if (name && !Number.isNaN(winIdx)) {
				cachedHostSession = name;
				cachedHostWindowIndex = winIdx;
				hostDetectFailures = 0;
				return name;
			}
		}
	}
	// Fallback: display-message from the current client
	const raw = tryRun("tmux display-message -p '#{session_name}'");
	const name = raw?.trim() || null;
	if (name) {
		cachedHostSession = name;
		hostDetectFailures = 0;
	} else {
		hostDetectFailures++;
	}
	return name;
}

function getHostWindowIndex(): number {
	if (cachedHostWindowIndex !== undefined) return cachedHostWindowIndex;
	// Force detection via getHostSession which populates cachedHostWindowIndex
	getHostSession();
	return cachedHostWindowIndex ?? 0;
}

/**
 * Invalidate the cached host session, forcing re-detection on next call.
 * Use when a tmux operation fails with "can't find session".
 */
export function invalidateHostSession(): void {
	cachedHostSession = undefined;
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
 * Also primes the host session cache if not yet detected.
 * Safe to call multiple times — idempotent.
 */
export function rehydrate(sessionManager: SessionReader): void {
	cached = loadPersistedState(sessionManager);
	// Prime host detection on first rehydrate
	getHostSession();
}

// ---------------------------------------------------------------------------
// Resolver — the single path to session identity
// ---------------------------------------------------------------------------

export interface ResolvedBinding {
	tmuxSessionName: string;
	stagingSessionName: string;
	/** The CC-attached host session, or same as tmuxSessionName when not in CC mode. */
	hostSessionName: string;
	/** The tmux window index within the host session where Pi is running. */
	hostWindowIndex: number;
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
 * Host session is always resolved from the cached live detection,
 * never from persisted state.
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

	// 3. Initialize fresh — full initialization of all fields
	if (!state) {
		const root = resolveProjectRoot(fallbackCwd);
		state = {
			version: 1,
			tmuxSessionName: deriveSessionName(root),
			createdFromCwd: root,
			updatedAt: Date.now(),
		};
		saveState(pi, state);
	}

	// Validate live tmux session
	const recreated = ensureTmuxSessionExists(state.tmuxSessionName);

	// Host is always from live cache, never from persisted state
	const host = getHostSession() ?? state.tmuxSessionName;
	return {
		tmuxSessionName: state.tmuxSessionName,
		stagingSessionName: deriveStagingName(state.tmuxSessionName),
		hostSessionName: host,
		hostWindowIndex: getHostWindowIndex(),
		recreated,
	};
}

/**
 * Ensure the primary tmux session exists. Returns true if it was recreated.
 */
function ensureTmuxSessionExists(name: string): boolean {
	if (isSessionAlive(name)) return false;
	// Session is missing — let callers handle creation.
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
