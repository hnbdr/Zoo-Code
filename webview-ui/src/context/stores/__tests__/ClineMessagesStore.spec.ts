import { type ClineMessage, type ExtensionMessage } from "@roo-code/types"

import { ClineMessagesStore } from "../clineMessagesStore"

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

describe("ClineMessagesStore", () => {
	let store: ClineMessagesStore

	// The store no longer self-hydrates from a window listener: the provider
	// routes every ExtensionMessage into its public handlers (see handleMessage
	// in ExtensionStateContext.tsx). Mirror that routing on the local instance
	// so `state` / `messageUpdated` posts flow through the same entry points
	// production uses.
	const dispatchWindowMessage = (data: unknown) => {
		const message = data as ExtensionMessage
		switch (message.type) {
			case "state":
				store.handleState(message)
				break
			case "messageUpdated":
				store.handleMessageUpdated(message)
				break
		}
	}

	beforeEach(() => {
		store = new ClineMessagesStore()
	})

	describe("replaceAll", () => {
		it("hydrates messages and returns them from the snapshot", () => {
			const messages = [makeMessage(1, "a"), makeMessage(2, "b")]
			store.replaceAll(messages)

			expect(store.getSnapshot().messages).toBe(messages)
		})

		it("replaces the previous array entirely", () => {
			store.replaceAll([makeMessage(1, "old")])
			const fresh = [makeMessage(1, "new")]
			store.replaceAll(fresh)

			expect(store.getSnapshot().messages).toHaveLength(1)
			expect(store.getSnapshot().messages[0]?.text).toBe("new")
		})

		it("keeps canonical element references across identical-content re-posts", () => {
			store.replaceAll([makeMessage(1, "a"), makeMessage(2, "b")])
			const canonical = store.getSnapshot().messages

			// A structured-clone twin of the same content: every element maps back
			// to the registered canonical, and the snapshot keeps its reference.
			store.replaceAll([makeMessage(1, "a"), makeMessage(2, "b")])
			expect(store.getSnapshot().messages).toBe(canonical)
			expect(store.getSnapshot().messages[0]).toBe(canonical[0])

			// Genuinely changed content is adopted as the new canonical element...
			store.replaceAll([makeMessage(1, "a"), makeMessage(2, "b2")])
			const grown = store.getSnapshot().messages
			expect(grown).not.toBe(canonical)
			expect(grown[0]).toBe(canonical[0]) // unchanged element keeps its reference
			expect(grown[1]?.text).toBe("b2")

			// ...and a later twin of THAT post maps back to the adopted instance.
			store.replaceAll([makeMessage(1, "a"), makeMessage(2, "b2")])
			expect(store.getSnapshot().messages).toBe(grown)
		})

		it("applies the seq guard: rejects seq <= stored seq", () => {
			const newer = [makeMessage(2, "newer")]
			store.replaceAll([makeMessage(1, "first")], 5)
			store.replaceAll(newer, 5) // equal seq — stale

			expect(store.getSnapshot().messages.map((m) => m.ts)).toEqual([1])
			expect(store.getSeq()).toBe(5)

			store.replaceAll(newer, 3) // lower seq — stale
			expect(store.getSnapshot().messages.map((m) => m.ts)).toEqual([1])

			store.replaceAll(newer, 6) // strictly greater — applies
			expect(store.getSnapshot().messages).toBe(newer)
			expect(store.getSeq()).toBe(6)
		})

		it("applies messages when neither side has a seq (backward compat)", () => {
			const messages = [makeMessage(1, "a")]
			store.replaceAll(messages)
			expect(store.getSnapshot().messages).toBe(messages)
			expect(store.getSeq()).toBeUndefined()
		})

		it("applies when stored seq is undefined but incoming has one (first seq push)", () => {
			const messages = [makeMessage(1, "a")]
			store.replaceAll(messages, 1)
			expect(store.getSnapshot().messages).toBe(messages)
			expect(store.getSeq()).toBe(1)
		})
	})

	describe("applyUpdates", () => {
		it("replaces an existing message by ts (last-write-wins)", () => {
			const original = { ...makeMessage(1, "before") }
			store.replaceAll([original, makeMessage(2, "other")])

			const updated = makeMessage(1, "after")
			store.applyUpdates(updated)

			const messages = store.getSnapshot().messages
			expect(messages).toHaveLength(2)
			expect(messages[0]).toBe(updated)
			expect(messages[0]?.text).toBe("after")
			// Unrelated element keeps its reference.
			expect(messages[1]?.text).toBe("other")
		})

		it("appends a message with an unknown ts instead of dropping it", () => {
			store.replaceAll([makeMessage(1, "existing")])

			const incoming = makeMessage(99, "unknown")
			store.applyUpdates(incoming)

			expect(store.getSnapshot().messages.map((m) => m.ts)).toEqual([1, 99])
			expect(store.getSnapshot().messages[1]).toBe(incoming)
		})

		it("handles a batch (Commit 1 messagesUpdated shape) in order", () => {
			store.replaceAll([makeMessage(1, "a")])
			store.applyUpdates([makeMessage(1, "a2"), makeMessage(3, "c")])

			expect(store.getSnapshot().messages.map((m) => m.text)).toEqual(["a2", "c"])
		})

		it("is a no-op for an empty batch", () => {
			const messages = [makeMessage(1, "a")]
			store.replaceAll(messages)
			store.applyUpdates([])
			expect(store.getSnapshot().messages).toBe(messages)
		})

		it("suppresses an identical-content duplicate update (canonical mapping)", () => {
			const listener = vi.fn()
			store.replaceAll([makeMessage(1, "a")])
			store.subscribe(listener)

			// The same ts + same content arriving as a fresh object maps back to
			// the canonical element already in the snapshot → no publish.
			store.applyUpdates(makeMessage(1, "a"))
			expect(listener).not.toHaveBeenCalled()
			expect(store.getSnapshot().messages[0]?.text).toBe("a")
		})

		it("partial growth is never deduplicated (fresh content always adopted)", () => {
			store.applyUpdates(makeMessage(1, "hel", true))
			const firstPartial = store.getSnapshot().messages[0]

			// Same ts, same partial flag, grown text: a different object every
			// time, and the partial fast path adopts it without a deep compare.
			store.applyUpdates(makeMessage(1, "hello", true))
			expect(store.getSnapshot().messages[0]).not.toBe(firstPartial)
			expect(store.getSnapshot().messages[0]?.text).toBe("hello")
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

			const messages = store.getSnapshot().messages
			expect(messages[0]?.text).toBe("shared text")
			// The message text field now points to the canonical instance from
			// the first flush (interned in place during replaceAll).
			const firstFlushText = first[0]?.text
			expect(messages[0]?.text).toBe(firstFlushText)
			// Cross-flush equal-content strings must share identity.
			expect(messages[1]?.text === "grown").toBe(true)
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

			const messages = [makeMessage(1, "a")]
			store.replaceAll(messages)
			expect(listener).toHaveBeenCalledTimes(1)

			// Structured-clone re-post: fresh array, same content. The registry
			// maps every element back to its canonical → element-wise equal to the
			// snapshot → nothing to publish.
			store.replaceAll([makeMessage(1, "a")])
			expect(listener).toHaveBeenCalledTimes(1)

			// The exact same array reference is likewise a no-op.
			store.replaceAll(messages)
			expect(listener).toHaveBeenCalledTimes(1)

			// Genuine content change DOES notify...
			store.replaceAll([makeMessage(1, "a-changed")], 10)
			expect(listener).toHaveBeenCalledTimes(2)

			// ...an identical-content re-post with a fresh seq passes the guard but
			// the registry collapses it back to the snapshot → still quiet.
			store.replaceAll([makeMessage(1, "a-changed")], 11)
			expect(listener).toHaveBeenCalledTimes(2)

			// ...while a stale seq push must not, even with new content.
			store.replaceAll([makeMessage(2, "b")], 5)
			expect(listener).toHaveBeenCalledTimes(2)
		})
	})

	describe("self-hydration (window message listener)", () => {
		it("hydrates from a full state post", () => {
			const messages = [makeMessage(1, "from state post")]

			dispatchWindowMessage({
				type: "state",
				state: { clineMessages: messages, clineMessagesSeq: 3 },
			})

			expect(store.getSnapshot().messages).toBe(messages)
			expect(store.getSeq()).toBe(3)
		})

		it("applies a messageUpdated post without setState on the provider", () => {
			dispatchWindowMessage({
				type: "state",
				state: { clineMessages: [makeMessage(1, "initial")], clineMessagesSeq: 1 },
			})

			dispatchWindowMessage({ type: "messageUpdated", clineMessage: makeMessage(1, "grown") })

			const messages = store.getSnapshot().messages
			expect(messages).toHaveLength(1)
			expect(messages[0]?.text).toBe("grown")
		})

		it("clears the previous task's messages when currentTaskId changes", () => {
			dispatchWindowMessage({
				type: "state",
				state: { currentTaskId: "task-a", clineMessages: [makeMessage(1, "a")], clineMessagesSeq: 1 },
			})

			dispatchWindowMessage({
				type: "state",
				state: { currentTaskId: "task-b", clineMessages: [makeMessage(2, "b")], clineMessagesSeq: 1 },
			})

			const messages = store.getSnapshot().messages
			expect(messages).toHaveLength(1)
			expect(messages[0]?.ts).toBe(2)
			// The interned strings of task-a were dropped before hydrating task-b.
			expect(store.getCacheSize()).toBeGreaterThan(0)
		})

		it("clears when currentTaskId changes even if the post omits clineMessages (Commit 4 lean posts)", () => {
			// Commit 4 made the queue-handler state post lean (no clineMessages).
			// A lean post is legal mid-task (same currentTaskId → no clear, see the
			// next test), but if it DOES carry a new currentTaskId the old task's
			// messages must still be dropped: its ChatView is unmounted (keyed by
			// currentTaskId) and the new task hydrates via its own full state post
			// that follows the switch. Holding on to task-a's rows under task-b's
			// header would be worse than a transient empty state.
			dispatchWindowMessage({
				type: "state",
				state: { currentTaskId: "task-a", clineMessages: [makeMessage(1, "a")], clineMessagesSeq: 1 },
			})
			dispatchWindowMessage({ type: "messageUpdated", clineMessage: makeMessage(2, "b") })

			// Task switch with NO clineMessages in the payload (bare state post).
			dispatchWindowMessage({
				type: "state",
				state: { currentTaskId: "task-b" },
			})

			expect(store.getSnapshot().messages).toEqual([])
			expect(store.getSeq()).toBeUndefined()
			// Interned strings of task-a were released by the clear.
			expect(store.getCacheSize()).toBe(0)

			// The new task's own hydration then re-populates the store.
			const hydration = [makeMessage(10, "task-b msg")]
			dispatchWindowMessage({
				type: "state",
				state: { currentTaskId: "task-b", clineMessages: hydration, clineMessagesSeq: 1 },
			})
			expect(store.getSnapshot().messages).toBe(hydration)
		})

		it("does not clear when a same-task state post omits clineMessages (cloud event path)", () => {
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

			expect(store.getSnapshot().messages.map((m) => m.ts)).toEqual([1, 2])
		})
	})

	describe("derived fields", () => {
		// The derived slice lives inside the published snapshot record (the
		// record object itself is recreated on each publish; FIELD identity
		// stabilization is what `useSelector` subscribers depend on).
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
			const snapshot = store.getSnapshot()

			expect(snapshot.messages).toEqual([])
			expect(snapshot.task).toBeUndefined()
			expect(snapshot.lastMessage).toBeUndefined()
			expect(snapshot.count).toBe(0)
			expect(snapshot.modifiedMessages).toEqual([])
			expect(snapshot.lastIsAsk).toBe(false)
			expect(snapshot.lastIsPartial).toBe(false)
			expect(snapshot.hasOpenApiRequest).toBe(false)
			expect(snapshot.hasCompletionResult).toBe(false)
			expect(snapshot.completionResultTs).toBeUndefined()
			expect(snapshot.completionCheckpoint).toBeUndefined()
			expect(snapshot.apiMetrics).toEqual({
				totalTokensIn: 0,
				totalTokensOut: 0,
				totalCacheWrites: undefined,
				totalCacheReads: undefined,
				totalCost: 0,
				contextTokens: 0,
			})
			expect(snapshot.latestTodos).toEqual([])
		})

		it("identical replaceAll re-post keeps the snapshot record untouched (dedup skip-notify)", () => {
			const messages = [makeMessage(1, "a"), makeMessage(2, "b")]
			store.replaceAll(messages)
			const snapshot = store.getSnapshot()

			// With the canonical registry the old "fresh array, same elements"
			// shape can no longer reach setMessages: an identical-content re-post
			// maps back element-wise and the whole publish is skipped — the record
			// object (and every field on it) keeps its identity.
			const listener = vi.fn()
			store.subscribe(listener)
			store.replaceAll([makeMessage(1, "a"), makeMessage(2, "b")])

			expect(listener).not.toHaveBeenCalled()
			expect(store.getSnapshot()).toBe(snapshot)
		})

		it("partial text growth: lastMessage reference does NOT change (boundary key), count stable", () => {
			store.replaceAll([makeMessage(1, "task"), makeMessage(2, "hel", true)])
			const partial = store.getSnapshot().lastMessage
			expect(partial?.text).toBe("hel")

			// Same ts/type/say/partial — only the text grew.
			store.applyUpdates(makeMessage(2, "hello world", true))

			const snapshot = store.getSnapshot()
			expect(snapshot.lastMessage).toBe(partial)
			expect(snapshot.count).toBe(2)
		})

		it("partial -> final: lastMessage is the NEW object carrying the final text", () => {
			store.replaceAll([makeMessage(1, "task"), makeMessage(2, "partial text", true)])
			const partial = store.getSnapshot().lastMessage

			store.applyUpdates(makeMessage(2, "final text"))

			const snapshot = store.getSnapshot()
			expect(snapshot.lastMessage).not.toBe(partial)
			expect(snapshot.lastMessage?.text).toBe("final text")
			expect(snapshot.lastMessage?.partial).toBeUndefined()
		})

		it("apiMetrics: identical usage keeps the reference (hasTokenUsageChanged), changed usage yields a new object with new values", () => {
			const usage = { tokensIn: 10, tokensOut: 20, cost: 0.5 }
			const messages = [makeMessage(1, "task"), makeApiReqStarted(2, usage)]
			store.replaceAll(messages)
			const metrics = store.getSnapshot().apiMetrics
			expect(metrics.totalTokensIn).toBe(10)
			expect(metrics.totalTokensOut).toBe(20)

			// Fresh array + fresh message object, identical parsed usage: the
			// TokenUsage reference must survive.
			store.replaceAll([messages[0]!, makeApiReqStarted(2, usage)])
			expect(store.getSnapshot().apiMetrics).toBe(metrics)

			// Changed usage: new reference AND new values.
			store.applyUpdates(makeApiReqStarted(2, { tokensIn: 30, tokensOut: 20, cost: 0.5 }))
			const updated = store.getSnapshot().apiMetrics
			expect(updated).not.toBe(metrics)
			expect(updated.totalTokensIn).toBe(30)
		})

		it("latestTodos: identical content keeps the array reference, changed content produces a new one", () => {
			const todos = [{ content: "one", status: "in_progress" }]
			const messages = [makeMessage(1, "task"), makeTodoAsk(2, todos)]
			store.replaceAll(messages)
			const first = store.getSnapshot().latestTodos
			expect(first).toEqual(todos)

			// getLatestTodo parses into a fresh array on every call — identity
			// must come from the JSON signature, not object equality.
			store.replaceAll([messages[0]!, makeTodoAsk(2, todos)])
			expect(store.getSnapshot().latestTodos).toBe(first)

			store.applyUpdates(makeTodoAsk(2, [{ content: "one", status: "completed" }]))
			const second = store.getSnapshot().latestTodos
			expect(second).not.toBe(first)
			expect(second).toEqual([{ content: "one", status: "completed" }])
		})

		it("clear() resets the derived slice to initial", () => {
			const usage = { tokensIn: 10, tokensOut: 20, cost: 0.5 }
			store.replaceAll([makeMessage(1, "task"), makeApiReqStarted(2, usage)], 3)
			expect(store.getSnapshot().count).toBe(2)
			expect(store.getSnapshot().apiMetrics.totalTokensIn).toBe(10)

			store.clear()
			const snapshot = store.getSnapshot()
			expect(snapshot.task).toBeUndefined()
			expect(snapshot.lastMessage).toBeUndefined()
			expect(snapshot.count).toBe(0)
			expect(snapshot.apiMetrics.totalTokensIn).toBe(0)
			expect(snapshot.latestTodos).toEqual([])

			// Derived is initial even after a clear on an already-empty store.
			store.clear()
			expect(store.getSnapshot().count).toBe(0)
		})

		it("flags: lastIsAsk/lastIsPartial/hasOpenApiRequest track the modified stream", () => {
			const openReq = makeApiReqStarted(2, { tokensIn: 1 })
			store.replaceAll([makeMessage(1, "task"), openReq])
			let snapshot = store.getSnapshot()
			expect(snapshot.lastIsAsk).toBe(false)
			expect(snapshot.hasOpenApiRequest).toBe(true)
			// The flag bundle is reference-stable while no flag flips.
			const flags = snapshot.lastMessageFlags

			store.applyUpdates({ ...openReq, text: JSON.stringify({ tokensIn: 2, cost: 0.1 }) } as ClineMessage)
			snapshot = store.getSnapshot()
			expect(snapshot.hasOpenApiRequest).toBe(false)
			expect(snapshot.lastMessageFlags).not.toBe(flags)
			expect(snapshot.lastMessageFlags).toEqual({
				lastIsAsk: false,
				lastIsPartial: false,
				hasOpenApiRequest: false,
			})
		})
	})

	describe("clear", () => {
		it("drops messages, seq, interned strings and canonical references", () => {
			store.replaceAll([makeMessage(1, "text")], 7)
			const before = store.getSnapshot().messages[0]
			store.clear()

			expect(store.getSnapshot().messages).toEqual([])
			expect(store.getSeq()).toBeUndefined()
			expect(store.getCacheSize()).toBe(0)

			// The registry was reset too: an identical-content re-post is now
			// adopted as a NEW canonical instead of mapping back to `before`.
			store.replaceAll([makeMessage(1, "text")])
			expect(store.getSnapshot().messages[0]).not.toBe(before)
		})
	})
})
