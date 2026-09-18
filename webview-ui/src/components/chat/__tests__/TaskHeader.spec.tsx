import { providerIdentifiers } from "@roo-code/types"
// npx vitest src/components/chat/__tests__/TaskHeader.spec.tsx

import React from "react"
import { renderWithExtensionState, screen, fireEvent, act } from "@/utils/test-utils"

import type { ClineMessage, ProviderSettings } from "@roo-code/types"

import { clineMessagesStore } from "@src/context/stores/clineMessagesStore"
import { taskHistoryStore } from "@src/context/stores/taskHistoryStore"

import TaskHeader, { TaskHeaderProps } from "../TaskHeader"

// Mock i18n
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key, // Simple mock that returns the key
	}),
	// Mock initReactI18next to prevent initialization errors in tests
	initReactI18next: {
		type: "3rdParty",
		init: vi.fn(),
	},
}))

// Mock the vscode API - use vi.hoisted to ensure the mock is available when vi.mock is hoisted
const { mockPostMessage } = vi.hoisted(() => ({
	mockPostMessage: vi.fn(),
}))
vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: mockPostMessage,
	},
}))

// Mock the VSCodeBadge component
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeBadge: ({ children }: { children: React.ReactNode }) => <div data-testid="vscode-badge">{children}</div>,
}))

// Create a variable to hold the mock state
const mockExtensionState: {
	apiConfiguration: ProviderSettings
	currentTaskItem: { id: string } | null
	clineMessages: any[]
	taskHistory: any[]
} = {
	apiConfiguration: {
		apiProvider: providerIdentifiers.anthropic,
		apiKey: "test-api-key",
		apiModelId: "claude-3-opus-20240229",
	} as ProviderSettings,
	currentTaskItem: { id: "test-task-id" },
	clineMessages: [],
	taskHistory: [],
}

// Mock the ExtensionStateContext
vi.mock("@src/context/ExtensionStateContext", () => ({
	ExtensionStateContextProvider: ({ children }: any) => children,
	useExtensionState: () => mockExtensionState,
}))

// Mock findLastIndex from @roo/array
vi.mock("@roo/array", () => ({
	findLastIndex: (array: any[], predicate: (item: any) => boolean) => {
		for (let i = array.length - 1; i >= 0; i--) {
			if (predicate(array[i])) {
				return i
			}
		}
		return -1
	},
}))

// Create a variable to hold the mock model info for useSelectedModel
let mockModelInfo: { contextWindow: number; maxTokens: number } | undefined = undefined

// Mock useSelectedModel hook
vi.mock("@/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({
		provider: providerIdentifiers.anthropic,
		id: "test-model",
		info: mockModelInfo,
		isLoading: false,
		isError: false,
	}),
}))

// Mock getModelMaxOutputTokens from @roo/api
let mockMaxOutputTokens = 0
vi.mock("@roo/api", () => ({
	getModelMaxOutputTokens: () => mockMaxOutputTokens,
}))

// Mock Mention so task.text renders as plain text without pulling in the
// @roo/context-mentions regex dependency. The mock is a spy: Mention renders
// inside the collapsed TaskHeader on every render of the component, so its
// call count doubles as a TaskHeader render counter for the dedup tests.
const { MentionSpy } = vi.hoisted(() => ({ MentionSpy: vi.fn() }))
vi.mock("../Mention", () => ({
	Mention: ({ text }: { text?: string }) => {
		MentionSpy()
		return <span>{text}</span>
	},
}))

// Commit 2: TaskHeader reads the task message through the REAL
// clineMessagesStore.useSelector (no module-level hook mock anymore), so every
// test hydrates the store singleton directly. Task-say message factory matching
// the minimal ClineMessage shape used elsewhere (ts/text/type/say).
const makeTaskMessage = (ts: number, text: string): ClineMessage =>
	({ type: "say", say: "task", ts, text }) as ClineMessage

describe("TaskHeader", () => {
	const defaultProps: TaskHeaderProps = {
		tokensIn: 100,
		tokensOut: 50,
		totalCost: 0.05,
		contextTokens: 200,
		buttonsDisabled: false,
		handleCondenseContext: vi.fn(),
	}

	const renderTaskHeader = (props: Partial<TaskHeaderProps> = {}) => {
		// TaskHeader reads `currentTaskItem` from the real taskHistoryStore
		// singleton now, so seed it from the mock state right before mounting
		// (the banner tests mutate `currentTaskItem` after beforeEach).
		taskHistoryStore.clear()
		taskHistoryStore.hydrate({ currentTaskItem: (mockExtensionState.currentTaskItem ?? undefined) as any })
		return renderWithExtensionState(<TaskHeader {...defaultProps} {...props} />)
	}

	// Commit 2: TaskHeader reads the task message from the store singleton via
	// the real clineMessagesStore.useSelector("task"). Every test starts from a
	// clean store with one task message ("Test task" — the text the existing
	// assertions expect), matching the previous module-level hook mock.
	beforeEach(() => {
		MentionSpy.mockClear()
		clineMessagesStore.clear()
		clineMessagesStore.replaceAll([makeTaskMessage(1, "Test task")])
	})

	it("should display cost when totalCost is greater than 0", () => {
		renderTaskHeader()
		expect(screen.getByText("$0.05")).toBeInTheDocument()
	})

	it("should not display cost when totalCost is 0", () => {
		renderTaskHeader({ totalCost: 0 })
		expect(screen.queryByText("$0.0000")).not.toBeInTheDocument()
	})

	it("should not display cost when totalCost is null", () => {
		renderTaskHeader({ totalCost: null as any })
		expect(screen.queryByText(/\$/)).not.toBeInTheDocument()
	})

	it("should not display cost when totalCost is undefined", () => {
		renderTaskHeader({ totalCost: undefined as any })
		expect(screen.queryByText(/\$/)).not.toBeInTheDocument()
	})

	it("should not display cost when totalCost is NaN", () => {
		renderTaskHeader({ totalCost: NaN })
		expect(screen.queryByText(/\$/)).not.toBeInTheDocument()
	})

	it("should render the condense context button in the collapsed state", () => {
		renderTaskHeader()
		// Button is visible without expanding the task header
		const buttons = screen.getAllByRole("button")
		const condenseButton = buttons.find((button) => button.querySelector("svg.lucide-list-chevrons-down-up"))
		expect(condenseButton).toBeDefined()
		expect(condenseButton?.querySelector("svg")).toBeInTheDocument()
	})

	it("should render the condense context button when expanded", () => {
		renderTaskHeader()
		const taskHeader = screen.getByText("Test task")
		fireEvent.click(taskHeader)

		const buttons = screen.getAllByRole("button")
		const condenseButton = buttons.find((button) => button.querySelector("svg.lucide-list-chevrons-down-up"))
		expect(condenseButton).toBeDefined()
		expect(condenseButton?.querySelector("svg")).toBeInTheDocument()
	})

	it("should call handleCondenseContext when condense context button is clicked", () => {
		const handleCondenseContext = vi.fn()
		renderTaskHeader({ handleCondenseContext })

		// Button is clickable in collapsed state without expanding first
		const buttons = screen.getAllByRole("button")
		const condenseButton = buttons.find((button) => button.querySelector("svg.lucide-list-chevrons-down-up"))
		expect(condenseButton).toBeDefined()
		fireEvent.click(condenseButton!)
		expect(handleCondenseContext).toHaveBeenCalledWith("test-task-id")
		// Clicking the condense button must not expand the header (stopPropagation guard).
		// The expanded state renders the "chat:task.title" label, which stays absent while collapsed.
		expect(screen.queryByText("chat:task.title")).not.toBeInTheDocument()
	})

	it("should disable the condense context button when buttonsDisabled is true", () => {
		const handleCondenseContext = vi.fn()
		renderTaskHeader({ buttonsDisabled: true, handleCondenseContext })

		// Button is disabled in collapsed state without expanding first
		const buttons = screen.getAllByRole("button")
		const condenseButton = buttons.find((button) => button.querySelector("svg.lucide-list-chevrons-down-up"))
		expect(condenseButton).toBeDefined()
		expect(condenseButton).toBeDisabled()
		fireEvent.click(condenseButton!)
		expect(handleCondenseContext).not.toHaveBeenCalled()
	})

	describe("Back to parent task button", () => {
		beforeEach(() => {
			mockPostMessage.mockClear()
		})

		it("should not show back button when parentTaskId is not provided", () => {
			renderTaskHeader()
			expect(screen.queryByText("chat:task.backToParentTask")).not.toBeInTheDocument()
		})

		it("should not show back button when parentTaskId is undefined", () => {
			renderTaskHeader({ parentTaskId: undefined })
			expect(screen.queryByText("chat:task.backToParentTask")).not.toBeInTheDocument()
		})

		it("should show back button when parentTaskId is provided", () => {
			renderTaskHeader({ parentTaskId: "parent-task-123" })
			expect(screen.getByText("chat:task.backToParentTask")).toBeInTheDocument()
		})

		it("should call vscode.postMessage with showTaskWithId when back button is clicked", () => {
			renderTaskHeader({ parentTaskId: "parent-task-123" })

			const backButton = screen.getByText("chat:task.backToParentTask")
			fireEvent.click(backButton)

			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "showTaskWithId",
				text: "parent-task-123",
			})
		})

		it("should show back button with ArrowLeft icon", () => {
			renderTaskHeader({ parentTaskId: "parent-task-123" })

			// Find the button containing the back text and verify it has the ArrowLeft icon
			const backButton = screen.getByText("chat:task.backToParentTask").closest("button")
			expect(backButton).toBeInTheDocument()
			expect(backButton?.querySelector("svg.lucide-arrow-left")).toBeInTheDocument()
		})
	})

	describe("Delegated parent waiting-on-subtask banner", () => {
		beforeEach(() => {
			mockPostMessage.mockClear()
		})

		afterEach(() => {
			mockExtensionState.currentTaskItem = { id: "test-task-id" }
			mockExtensionState.taskHistory = []
		})

		it("does not show the banner when currentTaskItem is not delegated", () => {
			mockExtensionState.currentTaskItem = { id: "test-task-id", status: "active" } as any
			renderTaskHeader()
			expect(screen.queryByText("chat:task.waitingOnSubtask")).not.toBeInTheDocument()
		})

		it("shows the banner when currentTaskItem is delegated with an awaitingChildId", () => {
			mockExtensionState.currentTaskItem = {
				id: "parent-1",
				status: "delegated",
				awaitingChildId: "child-1",
			} as any
			renderTaskHeader()
			expect(screen.getByText("chat:task.waitingOnSubtask")).toBeInTheDocument()
		})

		it("navigates to the awaited child when the banner is clicked", () => {
			mockExtensionState.currentTaskItem = {
				id: "parent-1",
				status: "delegated",
				awaitingChildId: "child-1",
			} as any
			renderTaskHeader()

			fireEvent.click(screen.getByText("chat:task.waitingOnSubtask"))

			expect(mockPostMessage).toHaveBeenCalledWith({ type: "showTaskWithId", text: "child-1" })
		})

		it("does not show an Abandon button (removed: implicit sever on re-delegation)", () => {
			mockExtensionState.currentTaskItem = {
				id: "parent-1",
				status: "delegated",
				awaitingChildId: "child-1",
			} as any
			renderTaskHeader()

			expect(screen.getByText("chat:task.waitingOnSubtask")).toBeInTheDocument()
			expect(screen.queryByText("history:abandonSubtask")).not.toBeInTheDocument()
		})
	})

	describe("Context window percentage calculation", () => {
		// The percentage should be calculated as:
		// contextTokens / (contextWindow - reservedForOutput) * 100
		// This represents the percentage of AVAILABLE input space used,
		// not the percentage of the total context window.

		beforeEach(() => {
			// Set up mock model with known contextWindow
			mockModelInfo = { contextWindow: 1000, maxTokens: 200 }
			// Set up mock for getModelMaxOutputTokens to return reservedForOutput
			mockMaxOutputTokens = 200
		})

		afterEach(() => {
			// Reset mocks
			mockModelInfo = undefined
			mockMaxOutputTokens = 0
		})

		it("should calculate percentage based on available input space, not total context window", () => {
			// With the formula: contextTokens / (contextWindow - reservedForOutput) * 100
			// If contextTokens = 200, contextWindow = 1000, reservedForOutput = 200
			// Then available input space = 1000 - 200 = 800
			// Percentage = 200 / 800 * 100 = 25%
			//
			// Old (incorrect) formula would have been: (200 + 200) / 1000 * 100 = 40%

			renderTaskHeader({ contextTokens: 200 })

			// The percentage should be rendered in the collapsed header state
			// Verify that 25% is displayed (correct formula) and NOT 40% (old incorrect formula)
			expect(screen.getByText("25%")).toBeInTheDocument()
			expect(screen.queryByText("40%")).not.toBeInTheDocument()
		})

		it("should handle edge case when available input space is zero", () => {
			// When contextWindow equals reservedForOutput, available space is 0
			// The percentage should be 0 to avoid division by zero
			mockModelInfo = { contextWindow: 200, maxTokens: 200 }
			mockMaxOutputTokens = 200

			renderTaskHeader({ contextTokens: 100 })

			// Should show 0% when available input space is 0
			expect(screen.getByText("0%")).toBeInTheDocument()
		})

		it("should treat a negative maxTokens (vscode-lm reports -1) as zero reserve", () => {
			// vscode-lm reports maxTokens: -1 (unlimited). The guard must treat that negative reserve
			// as zero, so available space == contextWindow rather than being inflated by a kept -1.
			mockModelInfo = { contextWindow: 1000, maxTokens: -1 }
			mockMaxOutputTokens = -1

			renderTaskHeader({ contextTokens: 250 })

			expect(screen.getByText("25%")).toBeInTheDocument()
		})
	})

	describe("Task 2 — dedup registry keeps at(0) stable across identical-content posts", () => {
		it("survives replaceAll with fresh objects of identical content", () => {
			renderTaskHeader()
			// Baseline: the mount render(s) of the collapsed header.
			const baseline = MentionSpy.mock.calls.length

			// Structured-clone twin of the beforeEach hydration content: fresh
			// array, fresh message object, same ts + text. The registry maps it
			// back to the canonical instance → skip-notify → zero re-renders.
			act(() => {
				clineMessagesStore.replaceAll([makeTaskMessage(1, "Test task")])
			})
			expect(MentionSpy.mock.calls.length).toBe(baseline)

			// Control: genuinely different content DOES re-render the header.
			act(() => {
				clineMessagesStore.replaceAll([makeTaskMessage(2, "Replaced task")])
			})
			expect(MentionSpy.mock.calls.length).toBeGreaterThan(baseline)
			expect(screen.getByText("Replaced task")).toBeInTheDocument()
		})
	})

	describe("Commit 2 — task text from the store (selector at(0))", () => {
		it("renders nothing until the first message arrives in the store", () => {
			act(() => {
				clineMessagesStore.clear()
			})
			renderTaskHeader()
			// No task message yet → TaskHeader returns null → no task text rendered.
			expect(screen.queryByText("Test task")).not.toBeInTheDocument()

			act(() => {
				clineMessagesStore.replaceAll([makeTaskMessage(7, "Arrived task")])
			})
			expect(screen.getByText("Arrived task")).toBeInTheDocument()
		})

		it("renders the new task's first message after a task switch (remount)", () => {
			const { unmount } = renderTaskHeader()
			expect(screen.getByText("Test task")).toBeInTheDocument()

			// Task switch: ChatView is keyed by currentTaskId, so the whole tree
			// (TaskHeader included) UNMOUNTS, then a fresh mount reads at(0) from
			// the new task's snapshot.
			act(() => {
				clineMessagesStore.clear()
				clineMessagesStore.replaceAll([makeTaskMessage(99, "New task")])
			})
			act(() => {
				unmount()
			})
			act(() => {
				renderTaskHeader()
			})

			expect(screen.getByText("New task")).toBeInTheDocument()
			expect(screen.queryByText("Test task")).not.toBeInTheDocument()
		})
	})
})
