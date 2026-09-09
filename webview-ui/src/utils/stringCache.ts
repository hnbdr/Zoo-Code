/**
 * String interning for the webview's IPC boundary.
 *
 * Every postMessage from the extension host deserializes fresh copies of the
 * same large LLM-context strings, polluting the webview heap. StringCache is
 * the last line of defense against the resulting leaks: it re-binds duplicate
 * strings in a freshly received object tree to a single canonical instance.
 * This is safe because string identity is meaningless at the JS level — it only
 * matters inside V8. Usage details belong at the actual call sites.
 */

/** True = intern this object subtree; false = pass it through untouched. */
export type StringCacheFilter = (value: { partial?: boolean }) => boolean

export class StringCache {
	private readonly cache = new Map<string, string>()
	private readonly shouldIntern?: StringCacheFilter

	constructor(shouldIntern?: StringCacheFilter) {
		this.shouldIntern = shouldIntern
	}

	/**
	 * Interns all strings in `value` in place. Assumes a freshly deserialized
	 * postMessage payload: plain JSON only, no cycles.
	 */
	intern<T>(value: T): T {
		return this.internValue(value) as T
	}

	/** Drops all interned strings. */
	clear(): void {
		this.cache.clear()
	}

	/** Number of interned strings. */
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
			return value
		}
		if (this.shouldIntern?.(value as { partial?: boolean }) === false) {
			return value
		}
		const record = value as Record<string, unknown>
		for (const key of Object.keys(record)) {
			record[key] = this.internValue(record[key])
		}
		return value
	}

	private internString(value: string): string {
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
