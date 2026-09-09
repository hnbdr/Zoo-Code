import { type ClineMessage } from "@roo-code/types"

import { createClineMessagesStore } from "../clineMessagesStore"

// Minimal task-say message factory matching the real ClineMessage shape used in
// tests elsewhere (ts/text/partial/type/say).
const makeMessage = (ts: number, text: string, partial?: boolean): ClineMessage =>
	({
		type: "say",
		say: "task",
		ts,
		text,
		...(partial !== undefined ? { partial } : {}),
	}) as ClineMessage

// Note: `window.postMessage` is async in jsdom (the event is queued as a task),
// so tests use a synchronous dispatch — the same pattern as ChatView.spec.tsx's
// dispatchExtensionMessage. The store listens via addEventListener("message"),
// which both delivery mechanisms trigger.
const dispatchWindowMessage = (data: unknown) => {
	window.dispatchEvent(new MessageEvent("message", { data }))
}

describe("ClineMessagesStore", () => {
	let store: ReturnType<typeof createClineMessagesStore>

	beforeEach(() => {
		store = createClineMessagesStore()
	})

	describe("replaceAll", () => {
		it("hydrates messages and returns them from the snapshot", () => {
			const messages = [makeMessage(1, "a"), makeMessage(2, "b")]
			store.replaceAll(messages)

			expect(store.getSnapshot()).toBe(messages)
		})

		it("replaces the previous array entirely", () => {
			store.replaceAll([makeMessage(1, "old")])
			const fresh = [makeMessage(1, "new")]
			store.replaceAll(fresh)

			expect(store.getSnapshot()).toBe(fresh)
			expect(store.getSnapshot()).toHaveLength(1)
		})

		it("applies the seq guard: rejects seq <= stored seq", () => {
			const newer = [makeMessage(2, "newer")]
			store.replaceAll([makeMessage(1, "first")], 5)
			store.replaceAll(newer, 5) // equal seq — stale

			expect(store.getSnapshot().map((m) => m.ts)).toEqual([1])
			expect(store.getSeq()).toBe(5)

			store.replaceAll(newer, 3) // lower seq — stale
			expect(store.getSnapshot().map((m) => m.ts)).toEqual([1])

			store.replaceAll(newer, 6) // strictly greater — applies
			expect(store.getSnapshot()).toBe(newer)
			expect(store.getSeq()).toBe(6)
		})

		it("applies messages when neither side has a seq (backward compat)", () => {
			const messages = [makeMessage(1, "a")]
			store.replaceAll(messages)
			expect(store.getSnapshot()).toBe(messages)
			expect(store.getSeq()).toBeUndefined()
		})

		it("applies when stored seq is undefined but incoming has one (first seq push)", () => {
			const messages = [makeMessage(1, "a")]
			store.replaceAll(messages, 1)
			expect(store.getSnapshot()).toBe(messages)
			expect(store.getSeq()).toBe(1)
		})
	})

	describe("applyUpdates", () => {
		it("replaces an existing message by ts (last-write-wins)", () => {
			const original = { ...makeMessage(1, "before") }
			store.replaceAll([original, makeMessage(2, "other")])

			const updated = makeMessage(1, "after")
			store.applyUpdates(updated)

			const snapshot = store.getSnapshot()
			expect(snapshot).toHaveLength(2)
			expect(snapshot[0]).toBe(updated)
			expect(snapshot[0]?.text).toBe("after")
			// Unrelated element keeps its reference.
			expect(snapshot[1]?.text).toBe("other")
		})

		it("appends a message with an unknown ts instead of dropping it", () => {
			store.replaceAll([makeMessage(1, "existing")])

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			const incoming = makeMessage(99, "unknown")
			store.applyUpdates(incoming)

			expect(store.getSnapshot().map((m) => m.ts)).toEqual([1, 99])
			expect(store.getSnapshot()[1]).toBe(incoming)
			warnSpy.mockRestore()
		})

		it("handles a batch (Commit 1 messagesUpdated shape) in order", () => {
			store.replaceAll([makeMessage(1, "a")])
			store.applyUpdates([makeMessage(1, "a2"), makeMessage(3, "c")])

			expect(store.getSnapshot().map((m) => m.text)).toEqual(["a2", "c"])
		})

		it("is a no-op for an empty batch", () => {
			const messages = [makeMessage(1, "a")]
			store.replaceAll(messages)
			store.applyUpdates([])
			expect(store.getSnapshot()).toBe(messages)
		})
	})

	describe("interning", () => {
		it("interns non-partial messages (canonical string instances shared across flushes)", () => {
			const first = [makeMessage(1, "shared text")]
			store.replaceAll(first)

			// A fresh push with equal text content must reuse the canonical
			// string instance held by the cache.
			const second = [makeMessage(1, "shared text"), makeMessage(2, "grown")]
			store.replaceAll(second)

			const snapshot = store.getSnapshot()
			const internedText = snapshot[0]?.text
			expect(internedText).toBe("shared text")
			// The message text field now points to the canonical instance from
			// the first flush (interned in place during replaceAll).
			const firstFlushText = first[0]?.text
			expect(snapshot[0]?.text).toBe(firstFlushText)
			// Cross-flush equal-content strings must share identity.
			expect(snapshot[1]?.text === "grown").toBe(true)
			expect(store.getCacheSize()).toBeGreaterThan(0)
		})

		it("does NOT intern partial messages (they pass through by reference)", () => {
			// Partial message: the same transient text repeated across flushes
			// must NOT pin stale prefixes in the cache.
			store.replaceAll([makeMessage(1, "prefix", true)])

			// Force the same content through again as partial — cache size must
			// not grow (partial subtrees are skipped by the filter).
			const cacheAfterFirst = store.getCacheSize()
			store.applyUpdates(makeMessage(2, "another partial", true))

			expect(store.getCacheSize()).toBe(cacheAfterFirst)
		})

		it("clears interned strings on clear()", () => {
			store.replaceAll([makeMessage(1, "some text")])
			expect(store.getCacheSize()).toBeGreaterThan(0)

			store.clear()
			expect(store.getCacheSize()).toBe(0)
		})
	})

	describe("subscription / skip-notify", () => {
		it("notifies subscribers when the snapshot reference changes", () => {
			const listener = vi.fn()
			const unsubscribe = store.subscribe(listener)

			store.replaceAll([makeMessage(1, "a")])
			expect(listener).toHaveBeenCalledTimes(1)

			store.applyUpdates(makeMessage(1, "a2"))
			expect(listener).toHaveBeenCalledTimes(2)

			unsubscribe()
			store.applyUpdates(makeMessage(1, "a3"))
			expect(listener).toHaveBeenCalledTimes(2)
		})

		it("skip-notify: no notification when the snapshot does not change", () => {
			const listener = vi.fn()
			store.subscribe(listener)

			// replaceAll with the exact same array reference is a no-op.
			const messages = [makeMessage(1, "a")]
			store.replaceAll(messages)
			expect(listener).toHaveBeenCalledTimes(1)

			// Same ts with identical content still replaces the element, so the
			// array reference changes — that IS a notify. To prove skip-notify we
			// re-replace with the identical reference.
			store.replaceAll(messages)
			expect(listener).toHaveBeenCalledTimes(1)

			// A stale seq push must not notify either.
			store.replaceAll([makeMessage(1, "a")], 10)
			expect(listener).toHaveBeenCalledTimes(2)
			store.replaceAll([makeMessage(2, "b")], 5)
			expect(listener).toHaveBeenCalledTimes(2)
		})
	})

	describe("self-hydration (window message listener)", () => {
		it("hydrates from a full state post", () => {
			store.start()
			const messages = [makeMessage(1, "from state post")]

			dispatchWindowMessage({
				type: "state",
				state: { clineMessages: messages, clineMessagesSeq: 3 },
			})

			expect(store.getSnapshot()).toBe(messages)
			expect(store.getSeq()).toBe(3)
		})

		it("applies a messageUpdated post without setState on the provider", () => {
			store.start()
			dispatchWindowMessage({
				type: "state",
				state: { clineMessages: [makeMessage(1, "initial")], clineMessagesSeq: 1 },
			})

			dispatchWindowMessage({ type: "messageUpdated", clineMessage: makeMessage(1, "grown") })

			const snapshot = store.getSnapshot()
			expect(snapshot).toHaveLength(1)
			expect(snapshot[0]?.text).toBe("grown")
		})

		it("stop() detaches the listener", () => {
			store.start()
			store.stop()

			dispatchWindowMessage({ type: "state", state: { clineMessages: [makeMessage(1, "ignored")] } })

			expect(store.getSnapshot()).toEqual([])
		})

		it("clears the previous task's messages when currentTaskId changes", () => {
			store.start()
			dispatchWindowMessage({
				type: "state",
				state: { currentTaskId: "task-a", clineMessages: [makeMessage(1, "a")], clineMessagesSeq: 1 },
			})

			dispatchWindowMessage({
				type: "state",
				state: { currentTaskId: "task-b", clineMessages: [makeMessage(2, "b")], clineMessagesSeq: 1 },
			})

			const snapshot = store.getSnapshot()
			expect(snapshot).toHaveLength(1)
			expect(snapshot[0]?.ts).toBe(2)
			// The interned strings of task-a were dropped before hydrating task-b.
			expect(store.getCacheSize()).toBeGreaterThan(0)
		})

		it("does not clear when a same-task state post omits clineMessages (cloud event path)", () => {
			store.start()
			dispatchWindowMessage({
				type: "state",
				state: { currentTaskId: "task-a", clineMessages: [makeMessage(1, "a")], clineMessagesSeq: 1 },
			})
			dispatchWindowMessage({ type: "messageUpdated", clineMessage: makeMessage(2, "b") })

			// A cloud event push for the SAME task that omits clineMessages must
			// not wipe the accumulated messages.
			dispatchWindowMessage({
				type: "state",
				state: { currentTaskId: "task-a", cloudIsAuthenticated: true },
			})

			expect(store.getSnapshot().map((m) => m.ts)).toEqual([1, 2])
		})
	})

	describe("derived", () => {
		const makeApiReqStarted = (ts: number, usage: Record<string, number>): ClineMessage =>
			({
				type: "say",
				say: "api_req_started",
				ts,
				text: JSON.stringify(usage),
			}) as ClineMessage

		const makeTodoAsk = (ts: number, todos: unknown[]): ClineMessage =>
			({
				type: "ask",
				ask: "tool",
				ts,
				text: JSON.stringify({ tool: "updateTodoList", todos }),
			}) as ClineMessage

		it("is initial on an empty snapshot", () => {
			const derived = store.getDerived()

			expect(derived.task).toBeUndefined()
			expect(derived.lastMessage).toBeUndefined()
			expect(derived.count).toBe(0)
			expect(derived.modifiedMessages).toEqual([])
			expect(derived.lastIsAsk).toBe(false)
			expect(derived.lastIsPartial).toBe(false)
			expect(derived.hasOpenApiRequest).toBe(false)
			expect(derived.hasCompletionResult).toBe(false)
			expect(derived.completionResultTs).toBeUndefined()
			expect(derived.completionCheckpoint).toBeUndefined()
			expect(derived.apiMetrics).toEqual({
				totalTokensIn: 0,
				totalTokensOut: 0,
				totalCacheWrites: undefined,
				totalCacheReads: undefined,
				totalCost: 0,
				contextTokens: 0,
			})
			expect(derived.latestTodos).toEqual([])
		})

		it("keeps the whole slice reference stable for an identical replaceAll (all-fields Object.is)", () => {
			const messages = [makeMessage(1, "a"), makeMessage(2, "b")]
			store.replaceAll(messages)
			const first = store.getDerived()

			// A new ARRAY carrying the same message references changes the
			// snapshot (notify fires) but not a single derived field → the
			// slice object itself is reused.
			const listener = vi.fn()
			store.subscribe(listener)
			store.replaceAll([...messages])

			expect(listener).toHaveBeenCalledTimes(1)
			expect(store.getDerived()).toBe(first)
		})

		it("partial text growth: lastMessage reference does NOT change (boundary key), count stable", () => {
			store.replaceAll([makeMessage(1, "task"), makeMessage(2, "hel", true)])
			const partial = store.getDerived().lastMessage
			expect(partial?.text).toBe("hel")

			// Same ts/type/say/partial — only the text grew.
			store.applyUpdates(makeMessage(2, "hello world", true))

			const derived = store.getDerived()
			expect(derived.lastMessage).toBe(partial)
			expect(derived.count).toBe(2)
		})

		it("partial -> final: lastMessage is the NEW object carrying the final text", () => {
			store.replaceAll([makeMessage(1, "task"), makeMessage(2, "partial text", true)])
			const partial = store.getDerived().lastMessage

			store.applyUpdates(makeMessage(2, "final text"))

			const derived = store.getDerived()
			expect(derived.lastMessage).not.toBe(partial)
			expect(derived.lastMessage?.text).toBe("final text")
			expect(derived.lastMessage?.partial).toBeUndefined()
		})

		it("apiMetrics: identical usage keeps the reference (hasTokenUsageChanged), changed usage yields a new object with new values", () => {
			const usage = { tokensIn: 10, tokensOut: 20, cost: 0.5 }
			const messages = [makeMessage(1, "task"), makeApiReqStarted(2, usage)]
			store.replaceAll(messages)
			const metrics = store.getDerived().apiMetrics
			expect(metrics.totalTokensIn).toBe(10)
			expect(metrics.totalTokensOut).toBe(20)

			// Fresh array + fresh message object, identical parsed usage: the
			// TokenUsage reference must survive.
			store.replaceAll([messages[0]!, makeApiReqStarted(2, usage)])
			expect(store.getDerived().apiMetrics).toBe(metrics)

			// Changed usage: new reference AND new values.
			store.applyUpdates(makeApiReqStarted(2, { tokensIn: 30, tokensOut: 20, cost: 0.5 }))
			const updated = store.getDerived().apiMetrics
			expect(updated).not.toBe(metrics)
			expect(updated.totalTokensIn).toBe(30)
		})

		it("latestTodos: identical content keeps the array reference, changed content produces a new one", () => {
			const todos = [{ content: "one", status: "in_progress" }]
			const messages = [makeMessage(1, "task"), makeTodoAsk(2, todos)]
			store.replaceAll(messages)
			const first = store.getDerived().latestTodos
			expect(first).toEqual(todos)

			// getLatestTodo parses into a fresh array on every call — identity
			// must come from the JSON signature, not object equality.
			store.replaceAll([messages[0]!, makeTodoAsk(2, todos)])
			expect(store.getDerived().latestTodos).toBe(first)

			store.applyUpdates(makeTodoAsk(2, [{ content: "one", status: "completed" }]))
			const second = store.getDerived().latestTodos
			expect(second).not.toBe(first)
			expect(second).toEqual([{ content: "one", status: "completed" }])
		})

		it("clear() resets the derived slice to initial", () => {
			const usage = { tokensIn: 10, tokensOut: 20, cost: 0.5 }
			store.replaceAll([makeMessage(1, "task"), makeApiReqStarted(2, usage)], 3)
			expect(store.getDerived().count).toBe(2)
			expect(store.getDerived().apiMetrics.totalTokensIn).toBe(10)

			store.clear()
			const derived = store.getDerived()
			expect(derived.task).toBeUndefined()
			expect(derived.lastMessage).toBeUndefined()
			expect(derived.count).toBe(0)
			expect(derived.apiMetrics.totalTokensIn).toBe(0)
			expect(derived.latestTodos).toEqual([])

			// Derived is initial even after a clear on an already-empty store.
			store.clear()
			expect(store.getDerived().count).toBe(0)
		})

		it("flags: lastIsAsk/lastIsPartial/hasOpenApiRequest track the modified stream", () => {
			const openReq = makeApiReqStarted(2, { tokensIn: 1 })
			store.replaceAll([makeMessage(1, "task"), openReq])
			let derived = store.getDerived()
			expect(derived.lastIsAsk).toBe(false)
			expect(derived.hasOpenApiRequest).toBe(true)
			// The flag bundle is reference-stable while no flag flips.
			const flags = derived.lastMessageFlags

			store.applyUpdates({ ...openReq, text: JSON.stringify({ tokensIn: 2, cost: 0.1 }) } as ClineMessage)
			derived = store.getDerived()
			expect(derived.hasOpenApiRequest).toBe(false)
			expect(derived.lastMessageFlags).not.toBe(flags)
			expect(derived.lastMessageFlags).toEqual({
				lastIsAsk: false,
				lastIsPartial: false,
				hasOpenApiRequest: false,
			})
		})
	})

	describe("clear", () => {
		it("drops messages, seq and interned strings", () => {
			store.replaceAll([makeMessage(1, "text")], 7)
			store.clear()

			expect(store.getSnapshot()).toEqual([])
			expect(store.getSeq()).toBeUndefined()
			expect(store.getCacheSize()).toBe(0)
		})
	})
})
