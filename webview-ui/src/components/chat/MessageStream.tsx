import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso"
import { LRUCache } from "lru-cache"

import { batchNearby } from "@src/utils/batchNearby"
import { isBoundary, isIgnorableBetweenTargets } from "@src/utils/chatBatchingPredicates"

import type { ClineAsk, ClineMessage, SuggestionItem } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"
import { clineMessagesStore } from "@src/context/stores/clineMessagesStore"
import type { ScrollFollowDisengageSource } from "@src/hooks/useScrollLifecycle"
import ChatRow from "./ChatRow"
import FileChangesPanel from "./FileChangesPanel"

// ===== REMOUNT POINT #1 (message list) =====
// A task switch remounts the whole MessageStream (ChatView is keyed by
// currentTaskId in App.tsx), so the stream-local state below is scoped to one
// task by construction. The Virtuoso is additionally keyed by task.ts so an
// in-place task reset (same task id) also resets the list.
const CHAT_DEFAULT_ITEM_HEIGHT = 180
const CHAT_VIEWPORT_BUFFER = {
	top: 600,
	bottom: 800,
} as const

/**
 * MessageStream is the pure render pipeline: it consumes the store snapshot
 * fields (raw messages per flush — the row pipeline must see every text
 * growth — plus the store's derived fields, computed once per flush inside
 * the store) through `clineMessagesStore.useSelector`. Everything the shell
 * needs to react to lives in the snapshot and reaches it through selectors,
 * not an uplink.
 *
 * The single remaining uplink is onCheckpointIndicesChange: checkpoint row
 * indices are derived from the GROUPED (view-processed) array, which cannot be
 * computed from raw store data, so only the shell's scrollToIndex needs them.
 */
export interface MessageStreamProps {
	// Downlinks: shell UI state the stream rows need to render/behave.
	isStreaming: boolean
	isHidden: boolean
	enableButtons: boolean
	primaryButtonText?: string
	currentFollowUpTs: number | null
	isFollowUpAutoApprovalPaused: boolean
	isCondensing: boolean
	// Scroll-lifecycle callbacks owned by the shell (useScrollLifecycle).
	virtuosoRef: React.RefObject<VirtuosoHandle>
	scrollContainerRef: React.RefObject<HTMLDivElement>
	followOutputCallback: (isAtBottom: boolean) => boolean | "auto"
	atBottomStateChangeCallback: (isAtBottom: boolean) => void
	handleRowHeightChange: (isTaller: boolean) => void
	enterUserBrowsingHistory: (source: ScrollFollowDisengageSource) => void
	// Row interaction callbacks owned by the shell (need input/clineAsk state).
	onSuggestionClick: (suggestion: SuggestionItem, event?: React.MouseEvent) => void
	onJumpToPreviousCheckpoint: () => void
	// Uplink: checkpoint indices within the grouped render array (view-derived;
	// published only when the joined signature changes).
	onCheckpointIndicesChange: (indices: number[]) => void
}

const MessageStream = memo(function MessageStream({
	isStreaming,
	isHidden,
	enableButtons,
	primaryButtonText,
	currentFollowUpTs,
	isFollowUpAutoApprovalPaused,
	isCondensing,
	virtuosoRef,
	scrollContainerRef,
	followOutputCallback,
	atBottomStateChangeCallback,
	handleRowHeightChange,
	enterUserBrowsingHistory,
	onSuggestionClick,
	onJumpToPreviousCheckpoint,
	onCheckpointIndicesChange,
}: MessageStreamProps) {
	// The raw message array is selected with the row-pipeline fields: the
	// render pipeline must observe every partial-text growth, so `messages` /
	// `modifiedMessages` change reference per flush and this component
	// re-renders with them. The boundary facts are selected in the same call
	// — MessageStream re-renders per flush anyway, so listing them here is
	// free (they ride on the already-scheduled render).
	const [messages, task, modifiedMessages, completionCheckpoint, completionResultTs] = clineMessagesStore.useSelector(
		"messages",
		"task",
		"modifiedMessages",
		"completionCheckpoint",
		"completionResultTs",
	)

	// Rows remember their expanded state across flushes; reset on task change.
	const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({})
	const prevExpandedRowsRef = useRef<Record<number, boolean>>()

	// The rows themselves subscribe to the store (ChatRowContent), but their
	// onHeightChange/scroll side effects live in the shell. The scroll container
	// is rendered here; the shell keeps a ref to it for wheel/touch handling.
	const everVisibleMessagesTsRef = useRef<LRUCache<number, boolean>>(
		new LRUCache({
			max: 100,
			ttl: 1000 * 60 * 5,
		}),
	)

	// ===== REMOUNT POINT #2 (Virtuoso) =====
	// keyed by task.ts so an in-place task reset remounts the list.
	const taskTs = task?.ts

	const visibleMessages = useMemo(() => {
		// Pre-compute checkpoint hashes that have associated user messages for O(1) lookup
		const userMessageCheckpointHashes = new Set<string>()
		modifiedMessages.forEach((msg) => {
			if (
				msg.say === "user_feedback" &&
				msg.checkpoint &&
				msg.checkpoint["type"] === "user_message" &&
				msg.checkpoint["hash"]
			) {
				userMessageCheckpointHashes.add(msg.checkpoint["hash"] as string)
			}
		})

		const newVisibleMessages = modifiedMessages.filter((message) => {
			// Filter out checkpoint_saved messages that should be suppressed
			if (message.say === "checkpoint_saved") {
				// Check if this checkpoint has the suppressMessage flag set
				if (
					message.checkpoint &&
					typeof message.checkpoint === "object" &&
					"suppressMessage" in message.checkpoint &&
					message.checkpoint.suppressMessage
				) {
					return false
				}
				// Also filter out checkpoint messages associated with user messages (legacy behavior)
				if (message.text && userMessageCheckpointHashes.has(message.text)) {
					return false
				}
			}

			if (everVisibleMessagesTsRef.current.has(message.ts)) {
				const alwaysHiddenOnceProcessedAsk: ClineAsk[] = [
					"api_req_failed",
					"resume_task",
					"resume_completed_task",
				]
				const alwaysHiddenOnceProcessedSay = [
					"api_req_finished",
					"api_req_retried",
					"api_req_deleted",
					"mcp_server_request_started",
				]
				if (message.ask && alwaysHiddenOnceProcessedAsk.includes(message.ask)) return false
				if (message.say && alwaysHiddenOnceProcessedSay.includes(message.say)) return false
				if (message.say === "text" && (message.text ?? "") === "" && (message.images?.length ?? 0) === 0) {
					return false
				}
				return true
			}

			switch (message.ask) {
				case "completion_result":
					if (message.text === "") return false
					break
				case "api_req_failed":
				case "resume_task":
				case "resume_completed_task":
					return false
			}
			switch (message.say) {
				case "api_req_finished":
				case "api_req_retried":
				case "api_req_deleted":
					return false
				case "api_req_retry_delayed":
				case "api_req_rate_limit_wait": {
					const last1 = modifiedMessages.at(-1)
					const last2 = modifiedMessages.at(-2)
					if (last1?.ask === "resume_task" && last2 === message) {
						return true
					} else if (message !== last1) {
						return false
					}
					break
				}
				case "text":
					if ((message.text ?? "") === "" && (message.images?.length ?? 0) === 0) return false
					break
				case "mcp_server_request_started":
					return false
			}
			return true
		})

		const viewportStart = Math.max(0, newVisibleMessages.length - 100)
		newVisibleMessages
			.slice(viewportStart)
			.forEach((msg: ClineMessage) => everVisibleMessagesTsRef.current.set(msg.ts, true))

		return newVisibleMessages
	}, [modifiedMessages])

	// TTL sweep for the visibility LRU (frees keys of rows that left the stream).
	useEffect(() => {
		const cleanupInterval = setInterval(() => {
			const cache = everVisibleMessagesTsRef.current
			const currentMessageIds = new Set(modifiedMessages.map((m: ClineMessage) => m.ts))
			const viewportMessages = visibleMessages.slice(Math.max(0, visibleMessages.length - 100))
			const viewportMessageIds = new Set(viewportMessages.map((m: ClineMessage) => m.ts))

			cache.forEach((_value: boolean, key: number) => {
				if (!currentMessageIds.has(key) && !viewportMessageIds.has(key)) {
					cache.delete(key)
				}
			})
		}, 60000)

		return () => clearInterval(cleanupInterval)
	}, [modifiedMessages, visibleMessages])

	useEffect(() => {
		const cache = everVisibleMessagesTsRef.current
		return () => {
			cache.clear()
		}
	}, [])

	useEffect(() => {
		if (isHidden) {
			everVisibleMessagesTsRef.current.clear()
		}
	}, [isHidden])

	const groupedMessages = useMemo(() => {
		const filtered: ClineMessage[] = visibleMessages

		// Helper to check if a message is a read_file ask that should be batched
		const isReadFileAsk = (msg: ClineMessage): boolean => {
			if (msg.type !== "ask" || msg.ask !== "tool") return false
			try {
				const tool = JSON.parse(msg.text || "{}")
				return tool.tool === "readFile" && !tool.batchFiles // Don't re-batch already batched
			} catch {
				return false
			}
		}

		// Helper to check if a message is a list_files ask that should be batched
		const isListFilesAsk = (msg: ClineMessage): boolean => {
			if (msg.type !== "ask" || msg.ask !== "tool") return false
			try {
				const tool = JSON.parse(msg.text || "{}")
				return (
					(tool.tool === "listFilesTopLevel" || tool.tool === "listFilesRecursive") && !tool.batchDirs // Don't re-batch already batched
				)
			} catch {
				return false
			}
		}

		// Set of tool names that represent file-editing operations
		const editFileTools = new Set([
			"editedExistingFile",
			"appliedDiff",
			"newFileCreated",
			"insertContent",
			"searchAndReplace",
		])

		// Helper to check if a message is a file-edit ask that should be batched
		const isEditFileAsk = (msg: ClineMessage): boolean => {
			if (msg.type !== "ask" || msg.ask !== "tool") return false
			try {
				const tool = JSON.parse(msg.text || "{}")
				return editFileTools.has(tool.tool) && !tool.batchDiffs // Don't re-batch already batched
			} catch {
				return false
			}
		}

		// Synthesize a batch of consecutive read_file asks into a single message
		const synthesizeReadFileBatch = (batch: ClineMessage[]): ClineMessage => {
			const batchFiles = batch.map((batchMsg) => {
				try {
					const tool = JSON.parse(batchMsg.text || "{}")
					return {
						path: tool.path || "",
						lineSnippet: tool.reason || "",
						isOutsideWorkspace: tool.isOutsideWorkspace || false,
						key: `${tool.path}${tool.reason ? ` (${tool.reason})` : ""}`,
						content: tool.content || "",
					}
				} catch {
					return { path: "", lineSnippet: "", key: "", content: "" }
				}
			})

			let firstTool
			try {
				firstTool = JSON.parse(batch[0].text || "{}")
			} catch {
				return batch[0]
			}
			return {
				...batch[0],
				text: JSON.stringify({ ...firstTool, batchFiles }),
			}
		}

		// Synthesize a batch of consecutive list_files asks into a single message
		const synthesizeListFilesBatch = (batch: ClineMessage[]): ClineMessage => {
			const batchDirs = batch.map((batchMsg) => {
				try {
					const tool = JSON.parse(batchMsg.text || "{}")
					return {
						path: tool.path || "",
						recursive: tool.tool === "listFilesRecursive",
						isOutsideWorkspace: tool.isOutsideWorkspace || false,
						key: tool.path || "",
					}
				} catch {
					return { path: "", recursive: false, key: "" }
				}
			})

			let firstTool
			try {
				firstTool = JSON.parse(batch[0].text || "{}")
			} catch {
				return batch[0]
			}
			return {
				...batch[0],
				text: JSON.stringify({ ...firstTool, batchDirs }),
			}
		}

		// Synthesize a batch of consecutive file-edit asks into a single message
		const synthesizeEditFileBatch = (batch: ClineMessage[]): ClineMessage => {
			const batchDiffs = batch.map((batchMsg) => {
				try {
					const tool = JSON.parse(batchMsg.text || "{}")
					return {
						path: tool.path || "",
						changeCount: 1,
						key: tool.path || "",
						content: tool.content || tool.diff || "",
						diffStats: tool.diffStats,
					}
				} catch {
					return { path: "", changeCount: 0, key: "", content: "" }
				}
			})

			let firstTool
			try {
				firstTool = JSON.parse(batch[0].text || "{}")
			} catch {
				return batch[0]
			}
			return {
				...batch[0],
				text: JSON.stringify({ ...firstTool, batchDiffs }),
			}
		}

		// Consolidate tool asks into batches, allowing ignorable messages between targets.
		// batchNearby skips over api_req_started, empty text rows, and reasoning rows that
		// models like qwen insert between tool calls during streaming.
		const readFileBatched = batchNearby(filtered, {
			isTarget: isReadFileAsk,
			isIgnorableBetweenTargets,
			isBoundary,
			synthesize: synthesizeReadFileBatch,
		})
		const listFilesBatched = batchNearby(readFileBatched, {
			isTarget: isListFilesAsk,
			isIgnorableBetweenTargets,
			isBoundary,
			synthesize: synthesizeListFilesBatch,
		})
		const result = batchNearby(listFilesBatched, {
			isTarget: isEditFileAsk,
			isIgnorableBetweenTargets,
			isBoundary,
			synthesize: synthesizeEditFileBatch,
		})

		if (isCondensing) {
			result.push({
				type: "say",
				say: "condense_context",
				ts: Date.now(),
				partial: true,
			} as ClineMessage)
		}
		return result
	}, [isCondensing, visibleMessages])

	const checkpointIndices = useMemo(() => {
		const indices: number[] = []
		for (let i = 0; i < groupedMessages.length; i++) {
			if (groupedMessages[i]?.say === "checkpoint_saved") {
				indices.push(i)
			}
		}
		return indices
	}, [groupedMessages])

	// ===== CHECKPOINT UPLINK (the only remaining one) =====
	// checkpointIndices address rows INSIDE the grouped render array (after
	// visibility filtering + tool batching), so they are a view artifact the
	// store cannot compute. The shell only needs them for scrollToIndex;
	// publish on content change (joined signature), never per flush.
	const lastCheckpointIndicesSigRef = useRef<string | undefined>(undefined)
	useEffect(() => {
		const signature = checkpointIndices.join(",")
		if (signature !== lastCheckpointIndicesSigRef.current) {
			lastCheckpointIndicesSigRef.current = signature
			onCheckpointIndicesChange(checkpointIndices)
		}
	}, [checkpointIndices, onCheckpointIndicesChange])

	// Row expansion state is stream-local. Expanding a row signals the shell's
	// scroll lifecycle that the user is browsing history (sticky-follow off).
	useEffect(() => {
		const prev = prevExpandedRowsRef.current
		let wasAnyRowExpandedByUser = false
		if (prev) {
			for (const [tsKey, isExpanded] of Object.entries(expandedRows)) {
				const ts = Number(tsKey)
				if (isExpanded && !(prev[ts] ?? false)) {
					wasAnyRowExpandedByUser = true
					break
				}
			}
		}

		if (wasAnyRowExpandedByUser) {
			enterUserBrowsingHistory("row-expansion")
		}

		prevExpandedRowsRef.current = expandedRows
	}, [enterUserBrowsingHistory, expandedRows])

	const handleSetExpandedRow = useCallback((ts: number, expand?: boolean) => {
		setExpandedRows((prev: Record<number, boolean>) => ({
			...prev,
			[ts]: expand === undefined ? !prev[ts] : expand,
		}))
	}, [])

	const toggleRowExpansion = useCallback(
		(ts: number) => {
			handleSetExpandedRow(ts)
		},
		[handleSetExpandedRow],
	)

	// Reset local stream state when the task row reference changes (a new
	// task was mounted — see App.tsx keying — or a task was reset in place).
	useEffect(() => {
		setExpandedRows({})
	}, [taskTs])

	const handleBatchFileResponse = useCallback((response: { [key: string]: boolean }) => {
		vscode.postMessage({ type: "askResponse", askResponse: "objectResponse", text: JSON.stringify(response) })
	}, [])

	const handleFollowUpUnmount = useCallback(() => {
		vscode.postMessage({ type: "cancelAutoApproval" })
	}, [])

	// ===== REMOUNT POINT #3 (message list) =====
	// computeMessageKey drives React reconciliation: whenever a message's ts or
	// its partial/full status changes, the corresponding ChatRow is remounted,
	// dropping the previous row instance's closures and DOM.
	const computeMessageKey = useCallback(
		(index: number, messageOrGroup: ClineMessage) =>
			`${messageOrGroup.ts}-${index}-${messageOrGroup.partial ? "partial" : "full"}`,
		[],
	)

	const itemContent = useCallback(
		(index: number, messageOrGroup: ClineMessage) => {
			const hasCheckpoint = modifiedMessages.some((message) => message.say === "checkpoint_saved")

			// ===== REMOUNT POINT #4 (per message row) =====
			// Keying by ts + partial/full status remounts a ChatRow whenever a
			// partial message is replaced by its grown/final version, releasing
			// the closures of the previous row instance.
			return (
				<ChatRow
					key={`${messageOrGroup.ts}-${messageOrGroup.partial ? "partial" : "full"}`}
					message={messageOrGroup}
					isExpanded={expandedRows[messageOrGroup.ts] || false}
					onToggleExpand={toggleRowExpansion}
					lastModifiedMessage={modifiedMessages.at(-1)}
					isLast={index === groupedMessages.length - 1}
					onHeightChange={handleRowHeightChange}
					isStreaming={isStreaming}
					onSuggestionClick={onSuggestionClick}
					onBatchFileResponse={handleBatchFileResponse}
					onFollowUpUnmount={handleFollowUpUnmount}
					isFollowUpAnswered={messageOrGroup.isAnswered === true || messageOrGroup.ts === currentFollowUpTs}
					isFollowUpAutoApprovalPaused={isFollowUpAutoApprovalPaused}
					editable={
						messageOrGroup.type === "ask" &&
						messageOrGroup.ask === "tool" &&
						(() => {
							let tool: any = {}
							try {
								tool = JSON.parse(messageOrGroup.text || "{}")
							} catch (_) {
								if (messageOrGroup.text?.includes("updateTodoList")) {
									tool = { tool: "updateTodoList" }
								}
							}
							return tool.tool === "updateTodoList" && enableButtons && !!primaryButtonText
						})()
					}
					hasCheckpoint={hasCheckpoint}
					completionCheckpoint={messageOrGroup.ts === completionResultTs ? completionCheckpoint : undefined}
					onJumpToPreviousCheckpoint={onJumpToPreviousCheckpoint}
				/>
			)
		},
		[
			expandedRows,
			toggleRowExpansion,
			modifiedMessages,
			groupedMessages.length,
			completionCheckpoint,
			completionResultTs,
			handleRowHeightChange,
			isStreaming,
			onSuggestionClick,
			handleBatchFileResponse,
			handleFollowUpUnmount,
			currentFollowUpTs,
			isFollowUpAutoApprovalPaused,
			enableButtons,
			primaryButtonText,
			onJumpToPreviousCheckpoint,
		],
	)

	const followOutput = useCallback(
		(isAtBottom: boolean) => {
			const decision = followOutputCallback(isAtBottom)
			return decision
		},
		[followOutputCallback],
	)

	const atBottomStateChange = useCallback(
		(isAtBottom: boolean) => {
			atBottomStateChangeCallback(isAtBottom)
		},
		[atBottomStateChangeCallback],
	)

	return (
		<>
			<div className="grow flex" ref={scrollContainerRef}>
				<Virtuoso
					ref={virtuosoRef}
					key={taskTs}
					className="scrollable grow overflow-y-scroll mb-1"
					computeItemKey={computeMessageKey}
					defaultItemHeight={CHAT_DEFAULT_ITEM_HEIGHT}
					increaseViewportBy={CHAT_VIEWPORT_BUFFER}
					data={groupedMessages}
					itemContent={itemContent}
					followOutput={followOutput}
					atBottomStateChange={atBottomStateChange}
					atBottomThreshold={10}
				/>
			</div>
			<FileChangesPanel clineMessages={messages} />
		</>
	)
})

export default MessageStream
