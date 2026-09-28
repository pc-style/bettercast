import clsx from "clsx";
import { StatusPill } from "components/StatusPill";
import type { Message, ProviderInfo } from "contracts/ai";
import { observer } from "mobx-react-lite";
import { type FC, useEffect, useRef } from "react";
import { ScrollView, Text, View } from "react-native";
import { ATTACHMENT_STATUS } from "ui/ai-view";
import { formatBytes } from "ui/format";
import { MessageText } from "./MessageText";
import { SourcesBlock } from "./SourcesBlock";
import { ToolCallCard } from "./ToolCallCard";

const UserMessage: FC<{ message: Message }> = ({ message }) => (
	<View className="self-end max-w-[85%] rounded-xl bg-neutral-500/10 px-3 py-2 gap-1">
		{message.blocks.map((b, i) =>
			b.type === "text" ? (
				// biome-ignore lint/suspicious/noArrayIndexKey: positional blocks
				<Text key={i} selectable className="text text-sm leading-5">
					{b.text}
				</Text>
			) : null,
		)}
		{!!message.attachments?.length && (
			<View className="flex-row flex-wrap gap-1">
				{message.attachments.map(a => (
					<Text key={a.id} className="darker-text text-xxs">
						📎 {a.name} · {formatBytes(a.sentBytes ?? a.bytes)}
						{a.status !== "ready" ? ` · ${ATTACHMENT_STATUS[a.status].label}` : ""}
					</Text>
				))}
			</View>
		)}
	</View>
);

const AssistantMessage: FC<{ message: Message; provider?: ProviderInfo; now: number; onRetryHint: boolean }> = ({
	message,
	provider,
	now,
	onRetryHint,
}) => {
	const streaming = message.status === "streaming";
	const model = provider?.models.find(m => m.id === message.modelId)?.label;
	const usage = message.usage;
	return (
		<View className="gap-1">
			<View className="flex-row items-center gap-2">
				<Text className="darker-text text-xxs font-semibold">
					{provider?.label ?? message.providerId ?? "Assistant"}
					{model ? ` · ${model}` : ""}
				</Text>
				{message.status === "cancelled" && <StatusPill label="Stopped" tone="neutral" />}
				{message.status === "error" && <StatusPill label="Failed" tone="danger" />}
			</View>
			{message.blocks.map((b, i) => {
				const lastBlock = i === message.blocks.length - 1;
				switch (b.type) {
					case "text":
						// biome-ignore lint/suspicious/noArrayIndexKey: positional blocks
						return <MessageText key={i} text={b.text} streaming={streaming && lastBlock} />;
					case "tool":
						return <ToolCallCard key={b.call.id} call={b.call} />;
					case "sources":
						// biome-ignore lint/suspicious/noArrayIndexKey: positional blocks
						return <SourcesBlock key={i} citations={b.citations} failures={b.failures} now={now} />;
				}
			})}
			{streaming && message.blocks.length === 0 && <Text className="darker-text text-sm">Thinking…</Text>}
			{!!message.error && (
				<Text selectable className="text-xs text-red-600 dark:text-red-400">
					{message.error}
					{onRetryHint ? "  ·  Retry ⌘R — your message is kept" : ""}
				</Text>
			)}
			{!!usage && (usage.inputTokens != null || usage.costUSD != null) && (
				<Text className="darker-text text-xxs">
					{[
						usage.inputTokens != null ? `${usage.inputTokens.toLocaleString()} in` : null,
						usage.outputTokens != null ? `${usage.outputTokens.toLocaleString()} out` : null,
						usage.costUSD != null
							? `${usage.estimated ? "≈" : ""}$${usage.costUSD.toFixed(4)}${usage.estimated ? " estimated" : ""}`
							: null,
					]
						.filter(Boolean)
						.join(" · ")}
				</Text>
			)}
		</View>
	);
};

export const Transcript: FC<{ messages: Message[]; providers: ProviderInfo[]; now: number }> = observer(
	({ messages, providers, now }) => {
		const ref = useRef<ScrollView>(null);
		const last = messages[messages.length - 1];
		const lastLength = last ? last.blocks.reduce((n, b) => n + (b.type === "text" ? b.text.length : 1), 0) : 0;
		// Follow streaming output.
		useEffect(() => {
			ref.current?.scrollToEnd({ animated: false });
		}, [messages.length, lastLength]);

		return (
			<ScrollView ref={ref} className="flex-1" contentContainerStyle={{ padding: 12, gap: 14 }}>
				{messages.map((m, i) =>
					m.role === "user" ? (
						<UserMessage key={m.id} message={m} />
					) : (
						<View key={m.id} className={clsx({ "opacity-90": m.status === "cancelled" })}>
							<AssistantMessage
								message={m}
								provider={providers.find(p => p.id === m.providerId)}
								now={now}
								onRetryHint={i === messages.length - 1}
							/>
						</View>
					),
				)}
			</ScrollView>
		);
	},
);
