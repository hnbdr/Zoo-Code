import { render, screen, fireEvent } from "@/utils/test-utils"

import { useExtensionState } from "@src/context/ExtensionStateContext"

import HistoryView from "../HistoryView"
import { taskHistoryStore } from "@src/context/stores/taskHistoryStore"

vi.mock("@src/context/ExtensionStateContext")
vi.mock("@src/utils/vscode")
// taskHistory is read from the TaskHistoryStore singleton now
// (HistoryView → useTaskSearch → taskHistoryStore.useSelector("history")), so
// the spec hydrates the real store instead of mocking a hook.

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

const mockTaskHistory = [
	{
		id: "1",
		number: 1,
		task: "Test task 1",
		ts: Date.now(),
		tokensIn: 100,
		tokensOut: 50,
		totalCost: 0.002,
		workspace: "/test/workspace",
	},
	{
		id: "2",
		number: 2,
		task: "Test task 2",
		ts: Date.now() + 1000,
		tokensIn: 200,
		tokensOut: 100,
		totalCost: 0.003,
		workspace: "/test/workspace",
	},
]

describe("HistoryView", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			cwd: "/test/workspace",
		})
		// Hydrate the real store singleton the component subscribes to.
		taskHistoryStore.clear()
		taskHistoryStore.replaceAll(mockTaskHistory as any)
	})

	afterEach(() => {
		taskHistoryStore.clear()
	})

	it("renders the history interface", () => {
		const onDone = vi.fn()
		render(<HistoryView onDone={onDone} />)

		// Check for main UI elements
		expect(screen.getByText("history:history")).toBeInTheDocument()
		expect(screen.getByText("history:done")).toBeInTheDocument()
		expect(screen.getByPlaceholderText("history:searchPlaceholder")).toBeInTheDocument()
	})

	it("calls onDone when done button is clicked", () => {
		const onDone = vi.fn()
		render(<HistoryView onDone={onDone} />)

		const doneButton = screen.getByText("history:done")
		fireEvent.click(doneButton)

		expect(onDone).toHaveBeenCalled()
	})
})
