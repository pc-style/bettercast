import type { QueueState } from "contracts/clipboard";
import { observer } from "mobx-react-lite";
import type { FC } from "react";
import { Text, View } from "react-native";
import { queueSummary } from "ui/clipboard-view";
import { StatusPill } from "./StatusPill";

/** Compact sequential-paste position, shown in footers while a queue exists. */
export const QueueIndicator: FC<{ queue: QueueState }> = observer(
	({ queue }) => {
		if (queue.state.status === "idle" || queue.items.length === 0) return null;
		const summary = queueSummary(queue);
		return (
			<View className="flex-row items-center gap-2">
				<StatusPill
					label={`Queue · ${summary.label}`}
					tone={summary.tone}
					dot
				/>
				{queue.reversed && (
					<Text className="text-xxs darker-text">Reversed</Text>
				)}
			</View>
		);
	},
);
