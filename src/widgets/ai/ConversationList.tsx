import clsx from "clsx";
import type { ConversationSummary } from "contracts/ai";
import type { FC } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import { relativeTime } from "ui/format";

/** Local conversation history. Used as the workspace sidebar and as the compact ⌘Y overlay. */
export const ConversationList: FC<{
	conversations: ConversationSummary[];
	activeId: string | null;
	highlight?: number;
	now: number;
	onOpen: (id: string) => void;
	onDelete?: (id: string) => void;
}> = ({ conversations, activeId, highlight, now, onOpen, onDelete }) => (
	<ScrollView contentContainerStyle={{ padding: 6 }}>
		{!conversations.length && (
			<Text className="darker-text text-xs px-2 py-3">No saved conversations. Chats are stored only on this Mac.</Text>
		)}
		{conversations.map((c, i) => {
			const active = highlight != null ? i === highlight : c.id === activeId;
			return (
				<View key={c.id} className={clsx("rounded-md flex-row items-center", { "bg-accent": active })}>
					<TouchableOpacity
						className="flex-1 px-2 py-[6px]"
						onPress={() => onOpen(c.id)}
						// @ts-expect-error macOS prop
						enableFocusRing={false}
					>
						<Text numberOfLines={1} className={clsx("text-xs", active ? "text-white font-medium" : "text")}>
							{c.title || "Untitled"}
						</Text>
						<Text className={clsx("text-xxs", active ? "text-white/80" : "darker-text")}>
							{relativeTime(c.updatedAt, now)} · {c.messageCount} msg
						</Text>
					</TouchableOpacity>
					{onDelete && (
						<TouchableOpacity
							accessibilityRole="button"
							accessibilityLabel={`Delete conversation ${c.title || "Untitled"}`}
							className="px-2 py-2"
							onPress={() => onDelete(c.id)}
						>
							<Text className={clsx("text-xs", active ? "text-white" : "darker-text")}>×</Text>
						</TouchableOpacity>
					)}
				</View>
			);
		})}
	</ScrollView>
);
