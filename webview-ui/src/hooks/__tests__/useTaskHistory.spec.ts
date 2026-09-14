import { act, renderHook } from "@testing-library/react"

import { type HistoryItem } from "@roo-code/types"

import { taskHistoryStore } from "@src/context/stores/taskHistoryStore"

import { useTaskHistory, useTaskHistorySelector } from "../useTaskHistory"

// Minimal factory matching the real HistoryItem shape (same convention as
// taskHistoryStore.spec.ts).
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

// The hooks bind to the module singleton, so drive the singleton directly and
// reset it between tests to prevent cross-test leakage.
beforeEach(() => {
	taskHistoryStore.clear()
})

describe("useTaskHistory", () => {
	it("returns the current store snapshot", () => {
		const items = [makeItem("1", 200), makeItem("2", 100)]
		taskHistoryStore.replaceAll(items)

		const { result } = renderHook(() => useTaskHistory())

		// The store publishes the exact array reference (interning rewrites
		// fields in place), so the hook must hand out the snapshot as-is.
		expect(result.current).toBe(items)
	})

	it("re-renders with the new snapshot on replaceAll and upsertItem", () => {
		taskHistoryStore.replaceAll([makeItem("1", 100)])

		const { result } = renderHook(() => useTaskHistory())
		expect(result.current.map((item) => item.id)).toEqual(["1"])

		act(() => {
			taskHistoryStore.upsertItem(makeItem("9", 999))
		})
		expect(result.current.map((item) => item.id)).toEqual(["9", "1"])

		act(() => {
			taskHistoryStore.replaceAll([makeItem("5", 500)])
		})
		expect(result.current.map((item) => item.id)).toEqual(["5"])
	})

	it("does not re-render when the snapshot reference is unchanged (skip-notify)", () => {
		taskHistoryStore.replaceAll([makeItem("1", 100)])
		const snapshot = taskHistoryStore.getSnapshot()

		let renderCount = 0
		const { result } = renderHook(() => {
			renderCount++
			return useTaskHistory()
		})
		const rendersBefore = renderCount

		// Re-publishing the identical reference must not notify subscribers.
		act(() => {
			taskHistoryStore.replaceAll(snapshot)
		})

		expect(renderCount).toBe(rendersBefore)
		expect(result.current).toBe(snapshot)
	})
})

describe("useTaskHistorySelector", () => {
	it("returns the selector result and recomputes when the snapshot changes", () => {
		taskHistoryStore.replaceAll([makeItem("1", 100)])

		const { result } = renderHook(() => useTaskHistorySelector((history) => history.map((item) => item.id)))
		expect(result.current).toEqual(["1"])

		act(() => {
			taskHistoryStore.upsertItem(makeItem("2", 200))
		})
		expect(result.current).toEqual(["2", "1"])
	})

	it("keeps an allocating selector result referentially stable between store changes", () => {
		// The selector allocates a fresh array on every call; the per-hook cache
		// keyed on the snapshot reference must keep the previous result while
		// the snapshot is unchanged (otherwise memoized children re-render).
		taskHistoryStore.replaceAll([makeItem("1", 100)])

		const { result, rerender } = renderHook(() => useTaskHistorySelector((history) => history.map((i) => i.id)))
		const first = result.current

		rerender()
		expect(result.current).toBe(first)

		act(() => {
			taskHistoryStore.upsertItem(makeItem("2", 200))
		})
		expect(result.current).not.toBe(first)
		expect(result.current).toEqual(["2", "1"])
	})

	it("applies an updated selector on the next snapshot change (cache keys on the snapshot)", () => {
		// Same contract as useClineMessagesSelector: the per-hook cache is keyed
		// on the snapshot reference, so a new selector function takes effect
		// when the snapshot moves — not on a plain re-render.
		taskHistoryStore.replaceAll([makeItem("1", 100), makeItem("2", 200)])

		const { result, rerender } = renderHook(
			({ pick }: { pick: (history: HistoryItem[]) => number }) => useTaskHistorySelector(pick),
			{ initialProps: { pick: (history: HistoryItem[]) => history.length } },
		)
		expect(result.current).toBe(2)

		rerender({ pick: (history: HistoryItem[]) => history.at(0)?.ts ?? 0 })
		// Snapshot unchanged — the cached (stale-selector) result is kept.
		expect(result.current).toBe(2)

		act(() => {
			taskHistoryStore.upsertItem(makeItem("3", 300))
		})
		expect(result.current).toBe(300)
	})
})
