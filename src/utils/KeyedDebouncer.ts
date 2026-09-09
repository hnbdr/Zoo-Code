/**
 * Debounces values per key: while the window is open, only the latest value for
 * each key is kept. When the window elapses (or `flushNow()`/`dispose()` runs),
 * all pending values are delivered to `flush` as an array.
 *
 * Use for high-frequency updates where only the newest state of each logical
 * unit matters (e.g. per-token message updates keyed by timestamp).
 */
export class KeyedDebouncer<Key, Value> {
	private readonly pending = new Map<Key, Value>()
	private timer?: NodeJS.Timeout
	private disposed = false

	constructor(
		private readonly flush: (values: Value[]) => void,
		private readonly delayMs: number,
	) {}

	/**
	 * Records the latest value for `key`. The timer starts on the first enqueue
	 * and is not reset by later ones, so a steady stream keeps one open window.
	 */
	enqueue(key: Key, value: Value): void {
		if (this.disposed) {
			return
		}

		this.pending.set(key, value)

		if (!this.timer) {
			this.timer = setTimeout(() => {
				this.timer = undefined
				this.flushPending()
			}, this.delayMs)
		}
	}

	/** Synchronously delivers all pending values. No-op when empty or disposed. */
	flushNow(): void {
		if (this.disposed) {
			return
		}

		this.clearTimer()
		this.flushPending()
	}

	/** Stops the timer, flushes pending values, and makes the debouncer inert. */
	dispose(): void {
		if (this.disposed) {
			return
		}

		this.clearTimer()
		this.flushPending()
		this.disposed = true
	}

	private clearTimer(): void {
		if (this.timer) {
			clearTimeout(this.timer)
			this.timer = undefined
		}
	}

	private flushPending(): void {
		if (this.pending.size === 0) {
			return
		}

		const values = Array.from(this.pending.values())
		this.pending.clear()
		this.flush(values)
	}
}
