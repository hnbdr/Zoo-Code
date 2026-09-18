import type { ClineMessage, HistoryItem } from "@roo-code/types"

/**
 * Prompt-history extraction shared by the store-side derived fields
 * (ClineMessagesStore `conversationPrompts`, TaskHistoryStore
 * `taskHistoryPrompts`).
 *
 * The lists used to be rebuilt inside `usePromptHistory`'s memo on every
 * `clineMessages` reference change — i.e. on every streaming-text flush —
 * which forced ChatTextArea to re-render per token. Moving the extraction
 * into the stores' derive step computes it exactly once per real snapshot
 * change and lets the published reference stay stable while the content is
 * unchanged (the stores compare the extracted lists by value).
 */

/** Maximum number of prompts kept for history navigation (memory bound). */
export const MAX_PROMPT_HISTORY_SIZE = 100

/**
 * User prompts from the active conversation: `say`/`user_feedback` messages
 * with non-empty text, newest first (ready for ArrowUp navigation). Returns
 * `undefined` when there is no active task (empty message list) so consumers
 * can distinguish "in a task with no prompts yet" ([]) from "no task"
 * (undefined → fall back to the task-history prompts).
 */
export const extractConversationPrompts = (messages: readonly ClineMessage[]): string[] | undefined => {
	if (messages.length === 0) {
		return undefined
	}
	return messages
		.filter((message) => message.type === "say" && message.say === "user_feedback" && message.text?.trim())
		.map((message) => message.text!)
		.slice(-MAX_PROMPT_HISTORY_SIZE)
		.reverse()
}

/**
 * User prompts from the persisted task history, current workspace only
 * (items without a workspace are legacy and always kept), bounded to
 * `MAX_PROMPT_HISTORY_SIZE` in the store's newest-first order. Returns []
 * while the workspace is unknown — the navigation source stays empty until
 * the provider's `cwd` arrives with a state post.
 */
export const extractTaskHistoryPrompts = (history: readonly HistoryItem[], workspace: string | undefined): string[] => {
	if (!workspace || history.length === 0) {
		return []
	}
	return history
		.filter((item) => item.task?.trim() && (!item.workspace || item.workspace === workspace))
		.map((item) => item.task)
		.slice(0, MAX_PROMPT_HISTORY_SIZE)
}
