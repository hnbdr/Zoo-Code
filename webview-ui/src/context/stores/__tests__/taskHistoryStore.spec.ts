import { type HistoryItem } from "@roo-code/types"

import { createTaskHistoryStore } from "../taskHistoryStore"

// Minimal factory matching the real HistoryItem shape used across webview tests
// (id/number/ts/task/token/cost fields; optionals omitted per item).
const makeItem = (id: string, ts: number, task = `task ${id}`): HistoryItem =>
	({
		id,
		number: Number(id.replace(/\D/g, "")) || 1,
		ts,
		task,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
	}) as HistoryItem

// window.postMessage is async in jsdom, so tests use a synchronous dispatch —
// the same pattern as ClineMessagesStore.spec.ts.
const dispatchWindowMessage = (data: unknown) => {
	window.dispatchEvent(new MessageEvent("message", { data }))
}

describe("TaskHistoryStore", () => {
	let store: ReturnType<typeof createTaskHistoryStore>

	beforeEach(() => {
		store = createTaskHistoryStore()
	})

	describe("replaceAll", () => {
		it("hydrates the history and returns it from the snapshot", () => {
			const items = [makeItem("1", 200), makeItem("2", 100)]
			store.replaceAll(items)

			expect(store.getSnapshot()).toBe(items)
		})

		it("replaces the previous array entirely", () => {
			store.replaceAll([makeItem("old", 1)])
			const fresh = [makeItem("new", 2)]
			store.replaceAll(fresh)

			expect(store.getSnapshot()).toBe(fresh)
			expect(store.getSnapshot()).toHaveLength(1)
			expect(store.getSnapshot()[0]?.id).toBe("new")
		})

		it("replaceAll([]) empties a previously-hydrated history and notifies", () => {
			store.replaceAll([makeItem("1", 100), makeItem("2", 200)])

			const listener = vi.fn()
			store.subscribe(listener)
			store.replaceAll([])

			expect(listener).toHaveBeenCalledTimes(1)
			expect(store.getSnapshot()).toEqual([])
		})
	})

	describe("upsertItem", () => {
		it("replaces an existing item by id (last-write-wins)", () => {
			const untouched = makeItem("1", 300)
			store.replaceAll([untouched, makeItem("2", 200)])

			const updated = makeItem("2", 200, "updated task")
			store.upsertItem(updated)

			const snapshot = store.getSnapshot()
			expect(snapshot).toHaveLength(2)
			expect(snapshot[1]).toBe(updated)
			// Unrelated element keeps its reference and position.
			expect(snapshot[0]).toBe(untouched)
		})

		it("prepends an unknown id", () => {
			const existing = makeItem("1", 300)
			store.replaceAll([existing])

			const incoming = makeItem("9", 999)
			store.upsertItem(incoming)

			expect(store.getSnapshot().map((item) => item.id)).toEqual(["9", "1"])
			expect(store.getSnapshot()[0]).toBe(incoming)
			// The untouched existing element keeps its reference.
			expect(store.getSnapshot()[1]).toBe(existing)
		})

		it("re-sorts newest-first after the merge", () => {
			// ts order broken on purpose: [200, 300].
			store.replaceAll([makeItem("1", 200), makeItem("2", 300)])

			store.upsertItem(makeItem("3", 250))

			expect(store.getSnapshot().map((item) => item.ts)).toEqual([300, 250, 200])
		})

		it("into an empty history: results in a one-element list", () => {
			const item = makeItem("1", 100)
			store.upsertItem(item)

			expect(store.getSnapshot()).toEqual([item])
		})
	})

	describe("subscription / skip-notify", () => {
		it("notifies subscribers when the snapshot reference changes", () => {
			const listener = vi.fn()
			const unsubscribe = store.subscribe(listener)

			store.replaceAll([makeItem("1", 100)])
			expect(listener).toHaveBeenCalledTimes(1)

			store.upsertItem(makeItem("2", 200))
			expect(listener).toHaveBeenCalledTimes(2)

			unsubscribe()
			store.upsertItem(makeItem("3", 300))
			expect(listener).toHaveBeenCalledTimes(2)
		})

		it("skip-notify: replaceAll with the same array reference does not notify", () => {
			const listener = vi.fn()
			store.subscribe(listener)

			const items = [makeItem("1", 100)]
			store.replaceAll(items)
			expect(listener).toHaveBeenCalledTimes(1)

			store.replaceAll(items)
			expect(listener).toHaveBeenCalledTimes(1)
		})

		it("an upsert that replaces with a different object still notifies", () => {
			// Content-deduplication (canonical references for identical content)
			// is task 2 (see plans/streaming-event-architecture.md) — until then
			// any fresh object is a real snapshot change.
			store.replaceAll([makeItem("1", 100)])

			const listener = vi.fn()
			store.subscribe(listener)
			store.upsertItem(makeItem("1", 100))

			expect(listener).toHaveBeenCalledTimes(1)
		})

		it("clear() notifies even from an already-empty history (fresh [] reference)", () => {
			const listener = vi.fn()
			store.subscribe(listener)

			store.clear()

			expect(listener).toHaveBeenCalledTimes(1)
			expect(store.getSnapshot()).toEqual([])
		})

		it("notifies every listener; unsubscribing one leaves the others attached", () => {
			const listenerA = vi.fn()
			const listenerB = vi.fn()
			const unsubscribeA = store.subscribe(listenerA)

			store.subscribe(listenerB)
			unsubscribeA()

			store.replaceAll([makeItem("1", 100)])

			expect(listenerA).not.toHaveBeenCalled()
			expect(listenerB).toHaveBeenCalledTimes(1)
		})
	})

	describe("interning", () => {
		it("interns history strings; clear() drops the cache", () => {
			store.replaceAll([makeItem("1", 100, "shared prompt")])
			expect(store.getCacheSize()).toBeGreaterThan(0)

			store.clear()
			expect(store.getCacheSize()).toBe(0)
			expect(store.getSnapshot()).toEqual([])
		})

		it("deduplicates strings across posts: a repeated post does not grow the cache", () => {
			// StringCache keys on the string VALUE, so re-interning the same
			// content (fresh deserialization on every post) must leave the size
			// unchanged, while a new string grows it. Also covers upsertItem
			// interning — dropping the intern call there fails the last assert.
			store.replaceAll([makeItem("1", 200, "recurring prompt")])
			const sizeAfterFirst = store.getCacheSize()
			expect(sizeAfterFirst).toBeGreaterThan(0)

			store.replaceAll([makeItem("1", 200, "recurring prompt")])
			expect(store.getCacheSize()).toBe(sizeAfterFirst)

			store.upsertItem(makeItem("2", 100, "brand new prompt"))
			expect(store.getCacheSize()).toBeGreaterThan(sizeAfterFirst)
		})
	})

	describe("self-hydration (window message listener)", () => {
		it("hydrates from a full state post carrying taskHistory", () => {
			store.start()
			const items = [makeItem("1", 100)]

			dispatchWindowMessage({ type: "state", state: { taskHistory: items } })

			expect(store.getSnapshot()).toBe(items)
		})

		it("keeps the current list when a lean state post omits the taskHistory key (Commit 4)", () => {
			// The extension conditionally spreads taskHistory — lean posts must
			// not wipe the history.
			store.start()
			const items = [makeItem("1", 100)]
			dispatchWindowMessage({ type: "state", state: { taskHistory: items } })

			dispatchWindowMessage({ type: "state", state: { version: "1.2.3" } })

			expect(store.getSnapshot()).toBe(items)
		})

		it("applies taskHistoryUpdated via replaceAll", () => {
			store.start()
			const items = [makeItem("1", 100), makeItem("2", 200)]

			dispatchWindowMessage({ type: "taskHistoryUpdated", taskHistory: items })

			expect(store.getSnapshot()).toBe(items)
		})

		it("applies taskHistoryItemUpdated via upsertItem", () => {
			store.start()
			dispatchWindowMessage({ type: "taskHistoryUpdated", taskHistory: [makeItem("1", 100)] })

			const updated = makeItem("1", 100, "renamed")
			dispatchWindowMessage({ type: "taskHistoryItemUpdated", taskHistoryItem: updated })

			const snapshot = store.getSnapshot()
			expect(snapshot).toHaveLength(1)
			expect(snapshot[0]).toBe(updated)
		})

		it("ignores taskHistoryItemUpdated without an item", () => {
			store.start()
			const items = [makeItem("1", 100)]
			dispatchWindowMessage({ type: "state", state: { taskHistory: items } })

			dispatchWindowMessage({ type: "taskHistoryItemUpdated" })

			expect(store.getSnapshot()).toBe(items)
		})

		it("keeps the list on a state post carrying an explicit taskHistory: undefined", () => {
			// The lean-post guard must treat an explicitly-undefined key like an
			// absent one (structured-clone can deliver either shape).
			store.start()
			const items = [makeItem("1", 100)]
			dispatchWindowMessage({ type: "state", state: { taskHistory: items } })

			dispatchWindowMessage({ type: "state", state: { taskHistory: undefined } })

			expect(store.getSnapshot()).toBe(items)
		})

		it("keeps the list on taskHistoryUpdated without a payload", () => {
			store.start()
			const items = [makeItem("1", 100)]
			dispatchWindowMessage({ type: "taskHistoryUpdated", taskHistory: items })

			dispatchWindowMessage({ type: "taskHistoryUpdated" })

			expect(store.getSnapshot()).toBe(items)
		})

		it("ignores unrelated message types", () => {
			store.start()
			const listener = vi.fn()
			store.subscribe(listener)

			dispatchWindowMessage({
				type: "messageUpdated",
				clineMessage: { ts: 1, type: "say", say: "text", text: "hi" },
			})
			dispatchWindowMessage({ type: "somethingElse" })

			expect(store.getSnapshot()).toEqual([])
			expect(listener).not.toHaveBeenCalled()
		})

		it("stop() detaches the listener; stop() without start() is safe", () => {
			store.stop()

			store.start()
			store.stop()
			store.stop()

			dispatchWindowMessage({ type: "state", state: { taskHistory: [makeItem("1", 100)] } })

			expect(store.getSnapshot()).toEqual([])
		})

		it("start() is idempotent (a double start does not double-apply)", () => {
			store.start()
			store.start()
			const listener = vi.fn()
			store.subscribe(listener)

			dispatchWindowMessage({ type: "state", state: { taskHistory: [makeItem("1", 100)] } })

			expect(listener).toHaveBeenCalledTimes(1)
		})
	})
})
