/**
 * POC — recursive string interning for webview state.
 *
 * Every postMessage from the extension host deserializes brand-new string objects
 * that V8 does NOT deduplicate between message boundaries. During assistant
 * streaming the same text is re-sent dozens of times as a full `clineMessages`
 * array, and `taskHistory` (the full cross-task history list) is re-sent on every
 * state broadcast — both historically produced ~N independent copies of the same
 * content in the webview heap.
 *
 * `StringCache` is a class so the webview can hold several independent stores,
 * each with its own lifetime and filter. The context manager
 * (ExtensionStateContextProvider) creates two instances:
 *
 *   historyCache — task data (taskHistory / currentTaskItem / taskHistoryItem).
 *                  Cross-task: the list holds EVERY task ever run in this
 *                  workspace (completed tasks persist), and taskHistoryItemUpdated
 *                  can arrive for parent/child tasks unrelated to the one being
 *                  viewed. It lives for the whole webview lifetime and is never
 *                  cleared on task switch. No filter.
 *   messageCache — clineMessages. Task-scoped: cleared on task switch, when the
 *                  whole old ChatView tree is unmounted (`key={currentTaskId}` in
 *                  App.tsx) and nothing references the cached strings anymore.
 *                  Filter: `(msg) => !msg.partial` — partial (mid-stream)
 *                  messages pass through by reference and are never interned.
 *
 * The filter is the constructor argument: return TRUE to intern the subtree's
 * strings (re-bind them in place to the canonical instances), FALSE to pass the
 * object through by reference. It is consulted for object subtrees during the
 * walk, so call sites can't forget the partial rule — the skip is baked into
 * the instance itself.
 *
 * Partial (mid-stream) messages are NEVER interned: each stream push replaces the
 * previous partial with its grown version, so pinning every intermediate prefix
 * would keep dozens of stale strings alive until the next task switch. Partials
 * pass through by reference — they are transient, and their references are
 * dropped when the ChatRow remounts (keyed by ts + partial/full status).
 *
 * `Map.get(candidate)` finds the canonical instance by value (V8 hashes the string
 * content once and caches the hash on the string object), so no content scan or
 * manual pre-filtering is needed. The map key and value are two references to the
 * SAME string object, so no extra copy is stored. Freshly-deserialized clones
 * become unreachable and the GC collects them.
 */

/**
 * Predicate deciding which object subtrees are interned: true = re-bind the
 * subtree's strings in place to the canonical instances, false = pass the object
 * through by reference. `partial?: boolean` mirrors ClineMessage so
 * `(msg) => !msg.partial` compiles as-is; fields absent from other shapes
 * (e.g. HistoryItem) read as `undefined`.
 */
export type StringCacheFilter = (value: { partial?: boolean }) => boolean

export class StringCache {
	private readonly cache = new Map<string, string>()
	private readonly shouldIntern?: StringCacheFilter

	constructor(shouldIntern?: StringCacheFilter) {
		this.shouldIntern = shouldIntern
	}

	/**
	 * Interns `value` IN PLACE: every string field at any nesting depth is
	 * re-bound to the canonical instance held in this store. The incoming value
	 * is freshly deserialized from postMessage and owned by the caller, so
	 * mutation is safe — this avoids allocating a second object tree per message
	 * (the previous clone approach produced ~2× garbage per streaming push).
	 * Object subtrees rejected by the filter pass through untouched. Deserialized
	 * JSON only — no Date/Map/Set/class instances, no circular references.
	 */
	intern<T>(value: T): T {
		return this.internValue(value) as T
	}

	/** Drops all interned strings. Call when the data using this store unmounts. */
	clear(): void {
		this.cache.clear()
	}

	/** Number of interned strings (useful for debugging). */
	get size(): number {
		return this.cache.size
	}

	private internValue(value: unknown): unknown {
		if (typeof value === "string") {
			return this.internString(value)
		}
		if (Array.isArray(value)) {
			for (let i = 0; i < value.length; i++) {
				value[i] = this.internValue(value[i])
			}
			return value
		}
		if (value === null || typeof value !== "object") {
			// number, boolean, undefined — nothing to intern.
			return value
		}
		// The filter is consulted for object subtrees: when it rejects the object
		// (e.g. a partial message via `(msg) => !msg.partial`), the subtree passes
		// through by reference — its strings stay transient and GC-able instead of
		// pinning every stream prefix.
		if (this.shouldIntern?.(value as { partial?: boolean }) === false) {
			return value
		}
		// Plain object (deserialized JSON): re-bind each own property in place.
		const record = value as Record<string, unknown>
		for (const key of Object.keys(record)) {
			record[key] = this.internValue(record[key])
		}
		return value
	}

	private internString(value: string): string {
		// Empty strings are returned as-is (no cache entry).
		if (value.length === 0) {
			return value
		}
		const existing = this.cache.get(value)
		if (existing !== undefined) {
			return existing
		}
		this.cache.set(value, value)
		return value
	}
}
