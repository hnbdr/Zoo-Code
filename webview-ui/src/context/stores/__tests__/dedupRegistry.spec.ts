import equal from "fast-deep-equal"

import { CanonicalRegistry, sameElements } from "../dedupRegistry"

/** Minimal entity mirroring the store payloads: keyed by `id`, interned text. */
interface Entity {
	id: number
	text: string
	partial?: boolean
}

const makeEntity = (id: number, text: string, partial?: boolean): Entity => ({
	id,
	text,
	...(partial !== undefined ? { partial } : {}),
})

describe("CanonicalRegistry", () => {
	describe("intern", () => {
		it("returns the canonical instance for an identical-content re-post", () => {
			const registry = new CanonicalRegistry<Entity>((entity) => entity.id)
			const first = makeEntity(1, "hello")
			expect(registry.intern(first)).toBe(first)

			// A structured-clone twin (same key, same content, new reference)
			// maps back to the registered instance.
			expect(registry.intern(makeEntity(1, "hello"))).toBe(first)
			expect(registry.size).toBe(1)
		})

		it("adopts a fresh object when the content actually changed for the same key", () => {
			const registry = new CanonicalRegistry<Entity>((entity) => entity.id)
			const first = registry.intern(makeEntity(1, "v1"))
			const changed = makeEntity(1, "v2")
			expect(registry.intern(changed)).toBe(changed)
			expect(changed).not.toBe(first)
			// The changed object becomes the new canonical.
			expect(registry.intern(makeEntity(1, "v2"))).toBe(changed)
			expect(registry.size).toBe(1)
		})

		it("tracks distinct keys independently", () => {
			const registry = new CanonicalRegistry<Entity>((entity) => entity.id)
			const a = registry.intern(makeEntity(1, "a"))
			const b = registry.intern(makeEntity(2, "b"))
			expect(a).not.toBe(b)
			expect(registry.intern(makeEntity(1, "a"))).toBe(a)
			expect(registry.intern(makeEntity(2, "b"))).toBe(b)
			expect(registry.size).toBe(2)
		})

		it("honors a custom contentEquals (partial fast path always adopts)", () => {
			// Mirrors the ClineMessagesStore wiring: a partial update is fresh
			// content by definition and must never map back to the canonical.
			const registry = new CanonicalRegistry<Entity>((entity) => entity.id, {
				contentEquals: (incoming, canonical) => incoming.partial !== true && equal(incoming, canonical),
			})
			const final = registry.intern(makeEntity(1, "a"))
			const partialTwin = makeEntity(1, "a", true)
			expect(registry.intern(partialTwin)).toBe(partialTwin)

			// After the partial was adopted, the settled final post differs in
			// content (partial flag) and is adopted once; an exact re-post of it
			// then maps back to the settled canonical.
			const settled = makeEntity(1, "a")
			expect(registry.intern(settled)).toBe(settled)
			expect(registry.intern(makeEntity(1, "a"))).toBe(settled)
			expect(final).not.toBe(settled)
		})
	})

	describe("string interning (owned by the registry)", () => {
		it("re-binds equal strings across posts to a shared instance", () => {
			const registry = new CanonicalRegistry<Entity>((entity) => entity.id)
			const a = registry.intern({ id: 1, text: "long shared string" })
			const b = { id: 2, text: "long shared string" }
			registry.intern(b)
			expect(b.text).toBe(a.text)
			expect(registry.stringCacheSize).toBe(1)
		})

		it("honors the shouldInternString filter but still registers the entity", () => {
			const registry = new CanonicalRegistry<Entity>((entity) => entity.id, {
				shouldInternString: (value) => !value.partial,
			})
			const partial = { id: 1, text: "streaming text", partial: true }
			registry.intern(partial)
			// Subtree skipped by the filter: no strings pinned...
			expect(registry.stringCacheSize).toBe(0)
			// ...but the canonical reference is still registered.
			expect(registry.size).toBe(1)
		})
	})

	describe("internList", () => {
		it("returns the input array when every element is already canonical", () => {
			const registry = new CanonicalRegistry<Entity>((entity) => entity.id)
			const list = [makeEntity(1, "a"), makeEntity(2, "b")]
			expect(registry.internList(list)).toBe(list)
			// Re-interning the same instances keeps the array identity.
			expect(registry.internList(list)).toBe(list)
		})

		it("returns a fresh array carrying canonical references when an element is new", () => {
			const registry = new CanonicalRegistry<Entity>((entity) => entity.id)
			const [first] = registry.internList([makeEntity(1, "a")])
			const freshSecond = makeEntity(2, "b")
			const grown = registry.internList([makeEntity(1, "a"), freshSecond])
			expect(grown).not.toBe(first)
			expect(grown[0]).toBe(first)
			expect(grown[1]).toBe(freshSecond)
		})

		it("maps an identical-content fresh list back to the registered references", () => {
			const registry = new CanonicalRegistry<Entity>((entity) => entity.id)
			const first = registry.internList([makeEntity(1, "a"), makeEntity(2, "b")])
			const repost = registry.internList([makeEntity(1, "a"), makeEntity(2, "b")])
			// The deserialized array itself is new, but every element is the
			// registered canonical — sameElements(current snapshot) then holds.
			expect(repost).not.toBe(first)
			expect(repost[0]).toBe(first[0])
			expect(repost[1]).toBe(first[1])
		})

		it("passes an empty array through by reference", () => {
			const registry = new CanonicalRegistry<Entity>((entity) => entity.id)
			const empty: Entity[] = []
			expect(registry.internList(empty)).toBe(empty)
		})
	})

	describe("clear", () => {
		it("drops canonical references and interned strings together", () => {
			const registry = new CanonicalRegistry<Entity>((entity) => entity.id)
			registry.internList([makeEntity(1, "shared text"), makeEntity(2, "other text")])
			expect(registry.size).toBe(2)
			expect(registry.stringCacheSize).toBeGreaterThan(0)

			registry.clear()
			expect(registry.size).toBe(0)
			expect(registry.stringCacheSize).toBe(0)

			// After clear an identical-content object is adopted as a NEW
			// canonical instead of mapping back to the dropped instance.
			const fresh = makeEntity(1, "shared text")
			expect(registry.intern(fresh)).toBe(fresh)
		})
	})
})

describe("sameElements", () => {
	it("is true for the same array reference", () => {
		const list = [makeEntity(1, "a")]
		expect(sameElements(list, list)).toBe(true)
	})

	it("is true for element-wise equal arrays", () => {
		const a = makeEntity(1, "a")
		const b = makeEntity(2, "b")
		expect(sameElements([a, b], [a, b])).toBe(true)
	})

	it("is false when the lengths differ", () => {
		const a = makeEntity(1, "a")
		expect(sameElements([a], [a, a])).toBe(false)
		expect(sameElements([a, a], [a])).toBe(false)
	})

	it("is false when any slot differs by reference", () => {
		expect(sameElements([makeEntity(1, "a")], [makeEntity(1, "a")])).toBe(false)
	})
})
