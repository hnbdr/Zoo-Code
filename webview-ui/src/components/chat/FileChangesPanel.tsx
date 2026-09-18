import { memo, useEffect, useState, useCallback, useRef } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, ChevronRight, FileDiff } from "lucide-react"
import { createTwoFilesPatch } from "diff"

import type { ClineMessage, ExtensionMessage } from "@roo-code/types"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui"
import { cn } from "@/lib/utils"
import { vscode } from "@src/utils/vscode"

import { clineMessagesStore } from "../../context/stores/clineMessagesStore"
import CodeAccordion from "../common/CodeAccordion"

interface FileChangesPanelProps {
	clineMessages: ClineMessage[] | undefined
	className?: string
}

const FileChangesPanel = memo(({ clineMessages, className }: FileChangesPanelProps) => {
	const { t } = useTranslation()
	const [panelExpanded, setPanelExpanded] = useState(false)
	const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
	const [finalContentByPath, setFinalContentByPath] = useState<Record<string, string | null>>({})
	const pendingPathsRef = useRef<Set<string>>(new Set())

	// Reset expanded file rows and final content cache when switching to a different task
	useEffect(() => {
		setExpandedPaths(new Set())
		setFinalContentByPath({})
		pendingPathsRef.current = new Set()
	}, [clineMessages])

	const [fileChanges, fileChangesByPath, fileChangesTotalStats] = clineMessagesStore.useSelector(
		"fileChanges",
		"fileChangesByPath",
		"fileChangesTotalStats",
	)

	const togglePath = useCallback((path: string) => {
		setExpandedPaths((prev) => {
			const next = new Set(prev)
			if (next.has(path)) next.delete(path)
			else next.add(path)
			return next
		})
	}, [])

	// Request final file content when a row is expanded and we have originalContent
	useEffect(() => {
		for (const path of expandedPaths) {
			const entries = fileChangesByPath.get(path)
			if (!entries?.length) continue
			const originalContent = entries[0].originalContent
			const lookupPath = path.startsWith("./") ? path.slice(2) : path
			if (
				originalContent !== undefined &&
				!(lookupPath in finalContentByPath) &&
				!pendingPathsRef.current.has(lookupPath)
			) {
				pendingPathsRef.current.add(lookupPath)
				vscode.postMessage({ type: "readFileContent", text: lookupPath })
			}
		}
	}, [expandedPaths, fileChangesByPath, finalContentByPath])

	// Listen for fileContent responses
	useEffect(() => {
		const handler = (event: MessageEvent) => {
			const message: ExtensionMessage = event.data
			if (message.type === "fileContent" && message.fileContent?.path != null) {
				const fc = message.fileContent
				pendingPathsRef.current.delete(fc.path)
				setFinalContentByPath((prev) => ({ ...prev, [fc.path]: fc.content ?? null }))
			}
		}
		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [])

	if (fileChanges.length === 0) return null

	const fileCount = fileChangesByPath.size

	return (
		<Collapsible open={panelExpanded} onOpenChange={setPanelExpanded} className={cn("px-3", className)}>
			<CollapsibleTrigger
				className={cn(
					"flex items-center gap-2 w-full py-2 rounded-md text-left text-vscode-foreground",
					"hover:bg-vscode-list-hoverBackground",
				)}>
				{panelExpanded ? (
					<ChevronDown className="size-4 shrink-0" aria-hidden />
				) : (
					<ChevronRight className="size-4 shrink-0" aria-hidden />
				)}
				<FileDiff className="size-4 shrink-0" aria-hidden />
				<span className="text-sm font-medium">
					{t("chat:fileChangesInConversation.header", { count: fileCount })}
				</span>
				{fileChangesTotalStats.added > 0 || fileChangesTotalStats.removed > 0 ? (
					<div
						className="flex items-center gap-2 ml-auto shrink-0"
						aria-label={`${fileChangesTotalStats.added} lines added, ${fileChangesTotalStats.removed} lines removed`}>
						<span className="text-xs font-medium text-vscode-charts-green" data-testid="total-added">
							+{fileChangesTotalStats.added}
						</span>
						<span className="text-xs font-medium text-vscode-charts-red" data-testid="total-removed">
							-{fileChangesTotalStats.removed}
						</span>
					</div>
				) : null}
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="flex flex-col gap-1 pb-2 pl-6">
					{Array.from(fileChangesByPath.entries()).map(([path, entries]) => {
						const originalContent = entries[0].originalContent
						const lookupPath = path.startsWith("./") ? path.slice(2) : path
						const finalContent = finalContentByPath[lookupPath]
						const hasMergedDiff =
							originalContent !== undefined && finalContent != null && finalContent !== ""
						const displayDiff = hasMergedDiff
							? createTwoFilesPatch(path, path, originalContent, finalContent)
							: entries.map((e) => e.diff).join("\n\n")
						const combinedStats = entries.reduce(
							(acc, e) => ({
								added: acc.added + (e.diffStats?.added ?? 0),
								removed: acc.removed + (e.diffStats?.removed ?? 0),
							}),
							{ added: 0, removed: 0 },
						)
						const isExpanded = expandedPaths.has(path)
						return (
							<div key={path} className="rounded border border-vscode-panel-border overflow-hidden">
								<CodeAccordion
									path={path}
									code={displayDiff}
									language="diff"
									isExpanded={isExpanded}
									onToggleExpand={() => togglePath(path)}
									diffStats={
										combinedStats.added > 0 || combinedStats.removed > 0 ? combinedStats : undefined
									}
									onJumpToFile={
										path
											? () =>
													vscode.postMessage({
														type: "openFile",
														text: path.startsWith("./") ? path : "./" + path,
													})
											: undefined
									}
								/>
							</div>
						)
					})}
				</div>
			</CollapsibleContent>
		</Collapsible>
	)
})

FileChangesPanel.displayName = "FileChangesPanel"

export default FileChangesPanel
