import { KeyedDebouncer } from "../KeyedDebouncer"

// npx vitest utils/__tests__/KeyedDebouncer.spec.ts

// Tests use an explicit delay so behavior is not coupled to any default.
const DELAY = 250

describe("KeyedDebouncer", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("debounces repeated updates for the same key into a single flush with the latest value", () => {
		vi.useFakeTimers()
		const flush = vi.fn()
		const debouncer = new KeyedDebouncer<string, string>(flush, DELAY)

		debouncer.enqueue("a", "1")
		debouncer.enqueue("a", "2")
		debouncer.enqueue("a", "3")

		// Nothing delivered yet — the window is still open.
		expect(flush).not.toHaveBeenCalled()

		vi.advanceTimersByTime(DELAY)

		// N updates collapse into 1 flush carrying the newest value.
		expect(flush).toHaveBeenCalledTimes(1)
		expect(flush).toHaveBeenCalledWith(["3"])
	})

	it("keeps the window open while values keep flowing", () => {
		vi.useFakeTimers()
		const flush = vi.fn()
		const debouncer = new KeyedDebouncer<string, string>(flush, DELAY)

		debouncer.enqueue("a", "1")
		vi.advanceTimersByTime(Math.floor(DELAY / 2))
		debouncer.enqueue("a", "2")
		vi.advanceTimersByTime(Math.floor(DELAY / 2) - 1)
		debouncer.enqueue("a", "3")

		// The timer never fired mid-stream: a single window started on the first
		// update, and everything after it shares that window.
		expect(flush).not.toHaveBeenCalled()

		vi.advanceTimersByTime(1)

		expect(flush).toHaveBeenCalledTimes(1)
		expect(flush).toHaveBeenCalledWith(["3"])
	})

	it("flushes each distinct key independently within one window", () => {
		vi.useFakeTimers()
		const flush = vi.fn()
		const debouncer = new KeyedDebouncer<string, string>(flush, DELAY)

		debouncer.enqueue("a", "one")
		debouncer.enqueue("b", "two")
		debouncer.enqueue("a", "one+")

		vi.advanceTimersByTime(DELAY)

		// Insertion order is preserved and re-enqueued keys keep their position.
		expect(flush).toHaveBeenCalledTimes(1)
		expect(flush).toHaveBeenCalledWith(["one+", "two"])
	})

	it("starts a fresh window after each timer flush", () => {
		vi.useFakeTimers()
		const flush = vi.fn()
		const debouncer = new KeyedDebouncer<string, string>(flush, DELAY)

		debouncer.enqueue("a", "first")
		vi.advanceTimersByTime(DELAY)
		debouncer.enqueue("a", "second")
		vi.advanceTimersByTime(DELAY)

		expect(flush).toHaveBeenCalledTimes(2)
		expect(flush.mock.calls[0][0]).toEqual(["first"])
		expect(flush.mock.calls[1][0]).toEqual(["second"])
	})

	it("flushNow delivers pending values synchronously", () => {
		vi.useFakeTimers()
		const flush = vi.fn()
		const debouncer = new KeyedDebouncer<string, string>(flush, DELAY)

		debouncer.enqueue("a", "1")
		debouncer.flushNow()

		expect(flush).toHaveBeenCalledTimes(1)
		expect(flush).toHaveBeenCalledWith(["1"])

		// The scheduled timer was cancelled by the explicit flush.
		vi.advanceTimersByTime(DELAY)
		expect(flush).toHaveBeenCalledTimes(1)
	})

	it("flushNow is a no-op when nothing is pending", () => {
		vi.useFakeTimers()
		const flush = vi.fn()
		const debouncer = new KeyedDebouncer<string, string>(flush, DELAY)

		debouncer.flushNow()

		expect(flush).not.toHaveBeenCalled()
	})

	it("dispose flushes anything still pending", () => {
		vi.useFakeTimers()
		const flush = vi.fn()
		const debouncer = new KeyedDebouncer<string, string>(flush, DELAY)

		debouncer.enqueue("a", "1")
		debouncer.dispose()

		expect(flush).toHaveBeenCalledTimes(1)
		expect(flush).toHaveBeenCalledWith(["1"])
	})

	it("is inert after dispose", () => {
		vi.useFakeTimers()
		const flush = vi.fn()
		const debouncer = new KeyedDebouncer<string, string>(flush, DELAY)

		debouncer.enqueue("a", "1")
		debouncer.dispose()
		debouncer.dispose() // safe to call twice

		debouncer.enqueue("b", "2")
		debouncer.flushNow()
		vi.advanceTimersByTime(DELAY)

		expect(flush).toHaveBeenCalledTimes(1)
		expect(flush).toHaveBeenCalledWith(["1"])
	})
})
