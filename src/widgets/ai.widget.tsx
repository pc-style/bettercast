import clsx from "clsx";
import { ActionBar } from "components/ActionBar";
import { ActionPanel, type PanelAction } from "components/ActionPanel";
import { BackButton } from "components/BackButton";
import { EmptyState } from "components/EmptyState";
import { Notice } from "components/Notice";
import type { AIContract } from "contracts/ai";
import { solNative } from "lib/SolNative";
import { observer } from "mobx-react-lite";
import { type FC, useEffect, useState } from "react";
import { Clipboard, Text, TouchableOpacity, View } from "react-native";
import { TextInput } from "react-native-macos";
import { useStore } from "store";
import { Widget } from "stores/ui.store";
import { lastAssistant, messageText, planSend, selectedProvider } from "ui/ai-view";
import { deliveryMessage } from "ui/clipboard-view";
import { useAIContract, useKeyHandler, useNativeKeyCapture, useNow } from "ui/hooks";
import { KEY } from "ui/keys";
import { moveSelection } from "ui/selection";
import { ApprovalCard } from "./ai/ApprovalCard";
import { ContextTray } from "./ai/ContextTray";
import { ConversationList } from "./ai/ConversationList";
import { ProviderPicker } from "./ai/ProviderPicker";
import { Transcript } from "./ai/Transcript";

type Overlay = "none" | "actions" | "provider" | "history";

const Chip: FC<{ label: string; on?: boolean; disabled?: boolean; onPress: () => void; hint?: string }> = ({
	label,
	on,
	disabled,
	onPress,
	hint,
}) => (
	<TouchableOpacity
		disabled={disabled}
		onPress={onPress}
		// @ts-expect-error macOS prop
		enableFocusRing={false}
		tooltip={hint}
	>
		<View
			className={clsx("flex-row items-center gap-1 rounded-md px-2 py-[3px] border", {
				"border-transparent bg-accent": on && !disabled,
				"border-color": !on || disabled,
				"opacity-40": disabled,
			})}
		>
			<Text className={clsx("text-xs", on && !disabled ? "text-white font-medium" : "text")} numberOfLines={1}>
				{label}
			</Text>
		</View>
	</TouchableOpacity>
);

const HistoryOverlay: FC<{ ai: AIContract; now: number; onClose: () => void }> = observer(({ ai, now, onClose }) => {
	const [index, setIndex] = useState(0);
	useNativeKeyCapture({ enter: true, vertical: true });
	useKeyHandler(({ keyCode, meta }) => {
		if (keyCode === KEY.DOWN || keyCode === KEY.UP) {
			setIndex(i => moveSelection(i, keyCode === KEY.DOWN ? 1 : -1, ai.conversations.length));
		} else if (keyCode === KEY.ENTER) {
			const c = ai.conversations[index];
			if (c) void ai.loadConversation(c.id);
			onClose();
		} else if (keyCode === KEY.ESC || (meta && keyCode === KEY.Y)) {
			onClose();
		}
		return true;
	});
	return (
		<View className="absolute top-0 bottom-0 left-0 right-0 bg-black/20 items-center pt-12">
			<View className="w-[380px] max-h-[320px] rounded-xl border border-window bg-white dark:bg-neutral-800 shadow-lg overflow-hidden">
				<Text className="darker-text text-xxs font-semibold uppercase px-3 pt-2">History · on this Mac</Text>
				<ConversationList
					conversations={ai.conversations}
					activeId={ai.conversationId}
					highlight={index}
					now={now}
					onOpen={id => {
						void ai.loadConversation(id);
						onClose();
					}}
				/>
			</View>
		</View>
	);
});

const AIView: FC<{ ai: AIContract; expanded: boolean }> = observer(({ ai, expanded }) => {
	const { ui } = useStore();
	const now = useNow(30_000);
	const [overlay, setOverlay] = useState<Overlay>("none");
	const provider = selectedProvider(ai.providers, ai.draft);
	const plan = planSend(ai.draft, ai.providers, ai.busy);
	const pending = ai.pendingApproval;
	const last = lastAssistant(ai.messages);
	const lastText = last ? messageText(last) : "";
	const canRetry = !ai.busy && ai.messages.some(m => m.role === "user");
	const title = ai.conversations.find(c => c.id === ai.conversationId)?.title ?? "New chat";

	useEffect(() => {
		if (!ai.initialized) void ai.initialize();
	}, [ai]);

	// Composer owns Enter (native submitKeyEvents) and arrows (caret movement).
	useNativeKeyCapture({ enter: false, vertical: false });
	// While a tool waits for approval, native swallows Enter so typing can't send or approve.
	useNativeKeyCapture({ enter: true, vertical: false }, !!pending && overlay === "none");

	const send = () => {
		if (!plan.canSend) return;
		void ai.send();
	};
	const attachFile = async () => {
		const path = await solNative.openFilePicker();
		if (path) void ai.addAttachment({ uri: path, origin: "file" });
	};
	const copyLast = () => {
		if (!lastText) return;
		Clipboard.setString(lastText);
		solNative.showToast("Answer copied", "success");
	};
	const insertLast = (mode: "insert" | "replace") => {
		if (!last || !ai.insert) return;
		void ai.insert(last.id, mode).then(result => {
			const message = deliveryMessage(result);
			if (message) solNative.showToast(message.text, message.tone === "success" ? "success" : "error");
		});
	};
	const exportChat = () => {
		if (!ai.conversationId || !ai.exportConversation) return;
		void ai.exportConversation(ai.conversationId).then(path => solNative.showToast(`Exported to ${path}`, "success"));
	};
	const addSelection = () => {
		void ai.captureSelection?.().then(a => {
			if (!a) solNative.showToast("No selected text in the previous app", "error");
		});
	};
	const toggleExpanded = () => ui.focusWidget(expanded ? Widget.AI : Widget.AI_WORKSPACE);
	const unavailable = (feature: string) => `${feature} isn't available in this build`;

	const actions: PanelAction[] = [
		{
			id: "copy",
			label: "Copy last answer",
			keys: ["⌘", "⇧", "C"],
			disabledReason: lastText ? undefined : "No answer yet",
			run: copyLast,
		},
		{
			id: "insert",
			label: "Insert answer into previous app",
			keys: ["⌘", "I"],
			disabledReason: !ai.insert ? unavailable("Insertion") : lastText ? undefined : "No answer yet",
			run: () => insertLast("insert"),
		},
		{
			id: "replace",
			label: "Replace selection with answer",
			disabledReason: !ai.insert ? unavailable("Replacing") : lastText ? undefined : "No answer yet",
			run: () => insertLast("replace"),
		},
		{
			id: "retry",
			label: "Retry last message",
			keys: ["⌘", "R"],
			disabledReason: canRetry ? undefined : "Nothing to retry",
			run: () => void ai.retry(),
		},
		{ id: "attach", label: "Attach file…", keys: ["⌘", "O"], run: () => void attachFile() },
		{
			id: "selection",
			label: "Add selected text from previous app",
			disabledReason: ai.captureSelection ? undefined : unavailable("Selection capture"),
			run: addSelection,
		},
		{
			id: "clip",
			label: "Attach from clipboard history…",
			run: () => ui.focusWidget(Widget.CLIPBOARD),
		},
		{
			id: "web",
			label: ai.draft.webSearch ? "Turn web search off" : "Turn web search on",
			disabledReason: provider?.capabilities.webSearch ? undefined : `${provider?.label ?? "This provider"} can't search the web`,
			run: () => ai.setDraft({ webSearch: !ai.draft.webSearch }),
		},
		{
			id: "tools",
			label: ai.draft.toolsEnabled ? "Turn tools off" : "Turn tools on (each call asks first)",
			disabledReason: provider?.capabilities.tools ? undefined : `${provider?.label ?? "This provider"} can't call tools`,
			run: () => ai.setDraft({ toolsEnabled: !ai.draft.toolsEnabled }),
		},
		{ id: "provider", label: "Change provider or model", keys: ["⌘", "P"], run: () => setOverlay("provider") },
		{ id: "new", label: "New chat", keys: ["⌘", "N"], run: () => ai.newConversation() },
		{ id: "history", label: "Open history", keys: ["⌘", "Y"], run: () => setOverlay("history") },
		{
			id: "export",
			label: "Export chat as Markdown",
			disabledReason: !ai.exportConversation ? unavailable("Export") : ai.conversationId ? undefined : "Nothing to export yet",
			run: exportChat,
		},
		{ id: "expand", label: expanded ? "Compact view" : "Expand to workspace", keys: ["⌘", "E"], run: toggleExpanded },
		{ id: "tools-settings", label: "Providers, MCP servers & approvals", run: () => ui.focusWidget(Widget.MCP_APPROVALS) },
	];

	useKeyHandler(({ keyCode, meta, shift }) => {
		if (pending) {
			if (keyCode === KEY.ENTER && meta) {
				const scope = shift ? "conversation" : "once";
				if (pending.allowedScopes.includes(scope)) ai.approve(pending.call.id, scope);
				return true;
			}
			if (keyCode === KEY.ESC) {
				ai.deny(pending.call.id);
				return true;
			}
			if (keyCode === KEY.ENTER) return true; // swallowed: never approve or send on bare ⏎
		}
		if (keyCode === KEY.PERIOD && meta && ai.busy) {
			ai.cancel();
			return true;
		}
		if (!meta) return false;
		switch (keyCode) {
			case KEY.K:
				setOverlay("actions");
				return true;
			case KEY.P:
				setOverlay("provider");
				return true;
			case KEY.Y:
				setOverlay("history");
				return true;
			case KEY.N:
				ai.newConversation();
				return true;
			case KEY.O:
				void attachFile();
				return true;
			case KEY.R:
				if (canRetry) void ai.retry();
				return true;
			case KEY.E:
				toggleExpanded();
				return true;
			case KEY.I:
				insertLast("insert");
				return true;
			case KEY.C:
				if (!shift) return false; // plain ⌘C copies the text selection
				copyLast();
				return true;
		}
		return false;
	}, overlay === "none");

	const providerLabel = provider
		? `${provider.label}${ai.draft.modelId ? ` · ${provider.models.find(m => m.id === ai.draft.modelId)?.label ?? ai.draft.modelId}` : ""}`
		: ai.initialized
			? "Choose provider"
			: "Checking…";

	return (
		<View
			className="flex-1"
			// @ts-expect-error macOS drag props
			draggedTypes={["fileUrl"]}
			onDrop={(e: { nativeEvent: { dataTransfer?: { files: { uri: string; type?: string; size?: number }[] } } }) => {
				for (const f of e.nativeEvent.dataTransfer?.files ?? [])
					void ai.addAttachment({ uri: f.uri, origin: "file", mimeType: f.type, bytes: f.size });
			}}
		>
			<View className="flex-row items-center gap-2 px-3 h-[46px]">
				<BackButton onPress={() => ui.focusWidget(Widget.SEARCH)} />
				<Text className="text text-base font-semibold flex-shrink" numberOfLines={1}>
					{title}
				</Text>
				<View className="flex-1" />
				<Chip label={providerLabel} onPress={() => setOverlay("provider")} hint="⌘P" />
				<Chip
					label="Web"
					on={ai.draft.webSearch}
					disabled={!provider?.capabilities.webSearch}
					onPress={() => ai.setDraft({ webSearch: !ai.draft.webSearch })}
					hint={provider?.capabilities.webSearch ? "Search the web with visible sources" : "This provider can't search the web"}
				/>
				<Chip
					label="Tools"
					on={ai.draft.toolsEnabled}
					disabled={!provider?.capabilities.tools}
					onPress={() => ai.setDraft({ toolsEnabled: !ai.draft.toolsEnabled })}
					hint={provider?.capabilities.tools ? "Each tool call asks for approval" : "This provider can't call tools"}
				/>
			</View>
			<View className="h-[1px] bg-lightBorder dark:bg-darkBorder" />

			<View className="flex-1 flex-row">
				{expanded && (
					<View className="w-[176px] border-r border-color">
						<ConversationList
							conversations={ai.conversations}
							activeId={ai.conversationId}
							now={now}
							onOpen={id => void ai.loadConversation(id)}
						/>
					</View>
				)}
				<View className="flex-1">
					{ai.messages.length ? (
						<Transcript messages={ai.messages} providers={ai.providers} now={now} />
					) : (
						<View className="flex-1">
							{ai.initialized && !ai.providers.some(p => p.available) ? (
								<View className="p-3">
									<Notice
										tone="warning"
										title="No AI provider available"
										detail={
											ai.providers.map(p => `${p.label}: ${p.reason ?? "unavailable"}`).join(" · ") ||
											"Install a supported CLI or configure a compatible endpoint in Providers & MCP settings."
										}
									/>
								</View>
							) : null}
							<EmptyState
								glyph="✦"
								title="Ask, attach, research"
								detail="Nothing is sent until you press ⏎. Clipboard history is never included unless you attach a specific item."
							>
								<Text className="darker-text text-xxs text-center mt-1">
									⇧⏎ new line · ⌘O attach · paste or drop images and files · ⌘P provider · ⌘K more
								</Text>
							</EmptyState>
						</View>
					)}

					{!!ai.error && (
						<View className="px-3 pb-2">
							<Notice tone="danger" title="Request failed" detail={`${ai.error}. Your message is kept — retry with ⌘R.`} />
						</View>
					)}

					{!!pending && (
						<ApprovalCard
							approval={pending}
							onApprove={scope => ai.approve(pending.call.id, scope)}
							onDeny={() => ai.deny(pending.call.id)}
						/>
					)}

					<ContextTray
						attachments={ai.draft.attachments}
						provider={provider}
						onRemove={id => ai.removeAttachment(id)}
					/>
					{plan.warnings.map(w => (
						<Text key={w} className="text-xxs text-amber-700 dark:text-amber-300 px-3 pb-1">
							{w}
						</Text>
					))}
					<View className="mx-3 mb-2 rounded-lg border border-color bg-white/70 dark:bg-black/20 px-3 py-2">
						<TextInput
							autoFocus
							multiline
							enableFocusRing={false}
							value={ai.draft.text}
							onChangeText={text => ai.setDraft({ text })}
							// Plain ⏎ is blocked natively and sends; ⇧⏎ falls through to AppKit as a newline.
							// (submitKeyEvents would insert the newline *and* submit on multiline inputs.)
							keyDownEvents={[{ key: "Enter", shiftKey: false, altKey: false }]}
							onKeyDown={(e: { nativeEvent: { key: string; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean } }) => {
								const k = e.nativeEvent;
								if (k.key === "Enter" && !k.shiftKey && !k.altKey && !k.metaKey) send();
							}}
							// @ts-expect-error macOS paste props are implemented natively but missing from resolved RN types
							pastedTypes={["fileUrl", "image", "string"]}
							onPaste={(e: { nativeEvent: { dataTransfer: { files: { uri: string; type?: string; size?: number }[] } } }) => {
								for (const f of e.nativeEvent.dataTransfer.files)
									void ai.addAttachment({ uri: f.uri, origin: "paste", mimeType: f.type, bytes: f.size });
							}}
							placeholder={ai.busy ? "Response in progress — ⌘. to stop" : "Message…"}
							className="text text-sm"
							style={{ minHeight: 36, maxHeight: expanded ? 180 : 96 }}
						/>
					</View>
				</View>
			</View>

			<ActionBar
				left={
					<Text
						numberOfLines={1}
						className={clsx("text-xxs", {
							"darker-text": plan.canSend || !ai.draft.text.trim(),
							"text-amber-700 dark:text-amber-300": !plan.canSend && !!ai.draft.text.trim(),
						})}
					>
						{!plan.canSend && ai.draft.text.trim() && plan.blocker ? plan.blocker : plan.disclosure}
					</Text>
				}
				actions={[
					{ label: "Actions", keys: ["⌘", "K"] },
					ai.busy
						? { label: "Stop", keys: ["⌘", "."], primary: true }
						: { label: "Send", keys: ["⏎"], primary: true, disabled: !plan.canSend },
				]}
			/>

			{overlay === "actions" && <ActionPanel title="AI" actions={actions} onClose={() => setOverlay("none")} />}
			{overlay === "provider" && (
				<ProviderPicker
					providers={ai.providers}
					providerId={ai.draft.providerId}
					modelId={ai.draft.modelId}
					onSelect={(providerId, modelId) => ai.setDraft({ providerId, modelId })}
					onClose={() => setOverlay("none")}
				/>
			)}
			{overlay === "history" && <HistoryOverlay ai={ai} now={now} onClose={() => setOverlay("none")} />}
		</View>
	);
});

export const AIWidget: FC<{ expanded?: boolean }> = observer(({ expanded = false }) => {
	const ai = useAIContract();
	const { ui } = useStore();
	if (!ai) {
		return (
			<View className="flex-1">
				<View className="flex-row items-center gap-3 px-3 h-[46px]">
					<BackButton onPress={() => ui.focusWidget(Widget.SEARCH)} />
					<Text className="text text-base font-semibold">AI</Text>
				</View>
				<View className="h-[1px] bg-lightBorder dark:bg-darkBorder" />
				<EmptyState
					glyph="⌧"
					title="The AI workspace isn't available in this build"
					detail="The AI service didn't load. Launcher search, clipboard and snippets are unaffected."
				/>
				<ActionBar actions={[{ label: "Back", keys: ["esc"] }]} />
			</View>
		);
	}
	return <AIView ai={ai} expanded={expanded} />;
});
