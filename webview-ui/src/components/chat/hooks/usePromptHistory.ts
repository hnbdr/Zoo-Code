import { useCallback, useEffect, useMemo, useState } from "react"

interface UsePromptHistoryProps {
	/**
	 * Conversation prompts (user_feedback texts, newest first) straight from
	 * `clineMessagesStore.useSelector("conversationPrompts")`. `undefined`
	 * means there is no active task; an empty array means a task without user
	 * messages yet (no fallback to the task history in that case).
	 */
	conversationPrompts: string[] | undefined
	/**
	 * Task-history prompts for the current workspace, from
	 * `taskHistoryStore.useSelector("taskHistoryPrompts")`. Consumed only when
	 * there is no active task.
	 */
	taskHistoryPrompts: string[]
	inputValue: string
	setInputValue: (value: string) => void
}

export interface UsePromptHistoryReturn {
	historyIndex: number
	setHistoryIndex: (index: number) => void
	tempInput: string
	setTempInput: (input: string) => void
	promptHistory: string[]
	handleHistoryNavigation: (
		event: React.KeyboardEvent<HTMLTextAreaElement>,
		showContextMenu: boolean,
		isComposing: boolean,
	) => boolean
	resetHistoryNavigation: () => void
	resetOnInputChange: () => void
}

/**
 * ArrowUp/ArrowDown navigation through the prompt history.
 *
 * The heavy part — deriving the prompt lists from the message stream and the
 * task history — lives in the stores, which publish reference-stable values.
 * This hook therefore only re-derives its source list when a prompt list
 * actually changes, never while streamed text grows token by token.
 */
export const usePromptHistory = ({
	conversationPrompts,
	taskHistoryPrompts,
	inputValue,
	setInputValue,
}: UsePromptHistoryProps): UsePromptHistoryReturn => {
	// Prompt history navigation state
	const [historyIndex, setHistoryIndex] = useState(-1)
	const [tempInput, setTempInput] = useState("")
	const [promptHistory, setPromptHistory] = useState<string[]>([])

	// Hybrid source: conversation prompts while a task is active, task-history
	// prompts only when starting fresh (no active conversation).
	const filteredPromptHistory = useMemo(() => {
		if (conversationPrompts !== undefined) {
			return conversationPrompts.length > 0 ? conversationPrompts : []
		}
		return taskHistoryPrompts
	}, [conversationPrompts, taskHistoryPrompts])

	// Update prompt history when filtered history changes and reset navigation
	useEffect(() => {
		setPromptHistory(filteredPromptHistory)
		// Reset navigation state when switching between history sources
		setHistoryIndex(-1)
		setTempInput("")
	}, [filteredPromptHistory])

	// Reset history navigation when user types (but not when we're setting it programmatically)
	const resetOnInputChange = useCallback(() => {
		if (historyIndex !== -1) {
			setHistoryIndex(-1)
			setTempInput("")
		}
	}, [historyIndex])

	// Helper to set cursor position after React renders
	const setCursorPosition = useCallback(
		(textarea: HTMLTextAreaElement, position: number | "start" | "end", length?: number) => {
			setTimeout(() => {
				if (position === "start") {
					textarea.setSelectionRange(0, 0)
				} else if (position === "end") {
					const len = length ?? textarea.value.length
					textarea.setSelectionRange(len, len)
				} else {
					textarea.setSelectionRange(position, position)
				}
			}, 0)
		},
		[],
	)

	// Helper to navigate to a specific history entry
	const navigateToHistory = useCallback(
		(newIndex: number, textarea: HTMLTextAreaElement, cursorPos: "start" | "end" = "start"): boolean => {
			if (newIndex < 0 || newIndex >= promptHistory.length) return false

			const historicalPrompt = promptHistory[newIndex]
			if (!historicalPrompt) return false

			setHistoryIndex(newIndex)
			setInputValue(historicalPrompt)
			setCursorPosition(textarea, cursorPos, historicalPrompt.length)

			return true
		},
		[promptHistory, setInputValue, setCursorPosition],
	)

	// Helper to return to current input
	const returnToCurrentInput = useCallback(
		(textarea: HTMLTextAreaElement, cursorPos: "start" | "end" = "end") => {
			setHistoryIndex(-1)
			setInputValue(tempInput)
			setCursorPosition(textarea, cursorPos, tempInput.length)
		},
		[tempInput, setInputValue, setCursorPosition],
	)

	const handleHistoryNavigation = useCallback(
		(event: React.KeyboardEvent<HTMLTextAreaElement>, showContextMenu: boolean, isComposing: boolean): boolean => {
			// Handle prompt history navigation
			if (!showContextMenu && promptHistory.length > 0 && !isComposing) {
				const textarea = event.currentTarget
				const { selectionStart, selectionEnd, value } = textarea
				const hasSelection = selectionStart !== selectionEnd
				const isAtBeginning = selectionStart === 0 && selectionEnd === 0
				const isAtEnd = selectionStart === value.length && selectionEnd === value.length

				// Handle smart navigation
				if (!hasSelection) {
					// Only navigate history with UP if cursor is at the very beginning
					if (event.key === "ArrowUp" && isAtBeginning) {
						event.preventDefault()
						// Save current input if starting navigation
						if (historyIndex === -1) {
							setTempInput(inputValue)
						}
						return navigateToHistory(historyIndex + 1, textarea, "start")
					}

					// Handle DOWN arrow - only in history navigation mode
					if (event.key === "ArrowDown" && historyIndex >= 0 && (isAtBeginning || isAtEnd)) {
						event.preventDefault()

						if (historyIndex > 0) {
							// Keep cursor position consistent with where we started
							return navigateToHistory(historyIndex - 1, textarea, isAtBeginning ? "start" : "end")
						} else if (historyIndex === 0) {
							returnToCurrentInput(textarea, isAtBeginning ? "start" : "end")
							return true
						}
					}
				}
			}
			return false
		},
		[promptHistory, historyIndex, inputValue, navigateToHistory, returnToCurrentInput],
	)

	const resetHistoryNavigation = useCallback(() => {
		setHistoryIndex(-1)
		setTempInput("")
	}, [])

	return {
		historyIndex,
		setHistoryIndex,
		tempInput,
		setTempInput,
		promptHistory,
		handleHistoryNavigation,
		resetHistoryNavigation,
		resetOnInputChange,
	}
}
