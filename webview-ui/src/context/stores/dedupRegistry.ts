/**
 * Canonical-reference registry shared by the self-hydrating stores
 * (ClineMessagesStore, taskHistoryStore).
 *
 * Every postMessage from the extension host deserializes a fresh object graph,
 * so unchanged entities (same key, same content) arrive as new references on
 * every post. The registry keeps ONE canonical instance per key and the stores
 * only ever publish what it hands back — so an identical-content re-post keeps
 * element references stable, which is what lets memoized consumers (e.g.
 * `memo(TaskHeader)` reading `at(0)`) and each store's skip-notify guard work
 * without per-consumer hacks.
 *
 * String interning lives INSIDE the registry: `intern` first re-binds the
 * entity's string fields through an internal `StringCache`, and `clear()`
 * drops the canonical references together with the interned strings. Stores
 * never touch StringCache directly.
 *
 * Otherwise it is a simple keyed collection: entries are only ever emptied
 * through `clear()`, which each store calls from its own `clear()` (task
 * switch / reset). Entries for keys that fall out of the snapshot (a deleted
 * message or history item) are intentionally not pruned: they pin small
 * objects for the lifetime of the session, the same bound the StringCache has
 * always accepted.
 */

import equal from "fast-deep-equal"

import { StringCache, type StringCacheFilter } from "@src/utils/stringCache"

/** Lookup key: `ts` for a ClineMessage, `id` for a HistoryItem. */
export type RegistryKey = string | number

/**
 * Default content equality: deep value comparison (`fast-deep-equal` starts
 * with a reference fast path, so already-shared values cost one `===`).
 * Everything crossing the IPC boundary is plain JSON, which `equal` compares
 * exactly. Stores with a streaming hot path override this to skip the
 * comparison entirely for mid-stream entities (see ClineMessagesStore and its
 * `partial` fast path).
 */

export interface CanonicalRegistryOptions<T> {
	/**
	 * Decides whether an incoming value is the same content as the current
	 * canonical for its key: true keeps the canonical, false adopts the
	 * incoming value as the new canonical. Arguments: (incoming, canonical).
	 * Defaults to deep value equality.
	 */
	contentEquals?: (incoming: T, canonical: T) => boolean

	/** Passed through to the internal StringCache (e.g. skip partial messages). */
	shouldInternString?: StringCacheFilter
}

export class CanonicalRegistry<T> {
	private readonly entries = new Map<RegistryKey, T>()
	private readonly strings: StringCache
	private readonly getKey: (value: T) => RegistryKey
	private readonly contentEquals: (incoming: T, canonical: T) => boolean

	constructor(getKey: (value: T) => RegistryKey, options: CanonicalRegistryOptions<T> = {}) {
		this.getKey = getKey
		this.strings = new StringCache(options.shouldInternString)
		this.contentEquals = options.contentEquals ?? equal
	}

	/**
	 * Returns the canonical instance for `value`'s key: the existing one when
	 * the content is unchanged, otherwise `value` itself — string-interned and
	 * adopted as the new canonical.
	 */
	intern(value: T): T {
		// Strings first: two posts that differ only in string identity are
		// duplicates, and the content comparison below sees the shared instances.
		this.strings.intern(value)
		const key = this.getKey(value)
		const canonical = this.entries.get(key)
		if (canonical !== undefined && this.contentEquals(value, canonical)) {
			return canonical
		}
		this.entries.set(key, value)
		return value
	}

	/**
	 * Interns every element. Returns the INPUT array when no element changed
	 * reference (the list was already canonical, keep its identity); otherwise
	 * a fresh array carrying the canonical references.
	 */
	internList(values: T[]): T[] {
		if (values.length === 0) {
			return values
		}
		let allCanonical = true
		const interned = values.map((value) => {
			const canonical = this.intern(value)
			if (canonical !== value) {
				allCanonical = false
			}
			return canonical
		})
		return allCanonical ? values : interned
	}

	/** Drops every canonical reference and every interned string. */
	clear(): void {
		this.entries.clear()
		this.strings.clear()
	}

	/** Number of tracked keys (test-only observability). */
	get size(): number {
		return this.entries.size
	}

	/** Number of strings in the internal cache (test-only observability). */
	get stringCacheSize(): number {
		return this.strings.size
	}
}

/**
 * Element-wise identity check (reference equality per slot). Used by the
 * stores to recognize an "unchanged" re-post: after canonicalization an
 * identical hydration post is element-wise equal to the current snapshot, so
 * the publish (and the notify) can be skipped entirely.
 */
export function sameElements<T>(candidate: readonly T[], prev: readonly T[]): boolean {
	if (candidate === prev) {
		return true
	}
	if (candidate.length !== prev.length) {
		return false
	}
	return candidate.every((value, index) => value === prev[index])
}
