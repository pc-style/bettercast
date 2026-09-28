import clsx from "clsx";
import { ActionBar } from "components/ActionBar";
import { BackButton } from "components/BackButton";
import { EmptyState } from "components/EmptyState";
import { Notice } from "components/Notice";
import { StatusPill } from "components/StatusPill";
import type { ClipboardContract } from "contracts/clipboard";
import { solNative } from "lib/SolNative";
import { observer } from "mobx-react-lite";
import type { FC } from "react";
import { ScrollView, Text, View } from "react-native";
import { useStore } from "store";
import { Widget } from "stores/ui.store";
import { deliveryMessage, KIND_GLYPH, orderedQueue, queueSummary, rowTitle } from "ui/clipboard-view";
import { useClipboardContract, useKeyHandler, useNativeKeyCapture } from "ui/hooks";
import { KEY } from "ui/keys";

const QueueView: FC<{ clip: ClipboardContract }> = observer(({ clip }) => {
	const { ui } = useStore();
	const queue = clip.queue;
	const items = orderedQueue(queue);
	const summary = queueSummary(queue);
	const status = queue.state.status;
	const active = status === "running" || status === "paused" || status === "interrupted";
	const done = status === "finished" || queue.position >= items.length;
	const lastMessage = queue.lastResult ? deliveryMessage(queue.lastResult) : null;

	useNativeKeyCapture({ enter: true, vertical: true, horizontal: true });

	const pasteNext = () => {
		if (done || status === "paused") return;
		void clip.queueNext().then(result => {
			const message = deliveryMessage(result);
			if (message) solNative.showToast(message.text, "error");
		});
	};

	useKeyHandler(({ keyCode, meta }) => {
		switch (keyCode) {
			case KEY.ENTER:
				if (status === "interrupted" || status === "paused") clip.queueResume();
				else pasteNext();
				return true;
			case KEY.RIGHT:
				if (!done) clip.queueSkip();
				return true;
			case KEY.SPACE:
				if (status === "paused" || status === "interrupted") clip.queueResume();
				else if (status === "running") clip.queuePause();
				return true;
			case KEY.R:
				meta ? clip.queueRestart() : clip.queueReverse();
				return true;
			case KEY.DELETE:
				if (!meta) return false;
				ui.confirm("Cancel the paste queue?", () => {
					clip.queueCancel();
					ui.focusWidget(Widget.CLIPBOARD);
				});
				return true;
		}
		return false;
	});

	return (
		<View className="flex-1">
			<View className="flex-row items-center gap-3 px-3 h-[50px]">
				<BackButton onPress={() => ui.focusWidget(Widget.CLIPBOARD)} />
				<Text className="text text-lg font-semibold flex-1">Paste queue</Text>
				<StatusPill label={summary.label} tone={summary.tone} dot />
			</View>
			<View className="h-[1px] bg-lightBorder dark:bg-darkBorder" />
			{status === "interrupted" && queue.state.status === "interrupted" && (
				<View className="px-3 pt-2">
					<Notice
						tone="danger"
						title="Queue interrupted"
						detail={`${queue.state.reason}. Item ${queue.position + 1} was not re-sent. Resume continues from it; skip moves past it.`}
					/>
				</View>
			)}
			{!items.length ? (
				<EmptyState
					glyph="⇶"
					title="No queue"
					detail="In clipboard history, mark items in the order you want with ⇥, then start the queue with ⌘⏎."
				/>
			) : (
				<ScrollView className="flex-1" contentContainerStyle={{ padding: 8 }}>
					{items.map((item, i) => {
						const isDone = i < queue.position;
						const isNext = i === queue.position && !done;
						return (
							<View
								key={item.id}
								className={clsx("flex-row items-center gap-3 rounded-lg px-3 h-10", {
									"bg-accent": isNext,
									"opacity-50": isDone,
								})}
							>
								<Text
									className={clsx("w-5 text-right text-xs font-semibold", isNext ? "text-white" : "darker-text")}
								>
									{isDone ? "✓" : i + 1}
								</Text>
								<Text className={clsx("text-xs", isNext ? "text-white" : "darker-text")}>{KIND_GLYPH[item.kind]}</Text>
								<Text
									numberOfLines={1}
									className={clsx("flex-1 text-sm", isNext ? "text-white" : "text", { "line-through": !item.available })}
								>
									{rowTitle(item)}
								</Text>
								{isNext && <Text className="text-white text-xxs font-semibold">NEXT</Text>}
								{!item.available && <Text className="text-red-500 text-xxs">Missing</Text>}
							</View>
						);
					})}
				</ScrollView>
			)}
			<View className="px-4 pb-1">
				<Text className="darker-text text-xxs">
					{lastMessage
						? lastMessage.text
						: queue.lastResult?.status === "dispatched"
							? "Last paste was sent. Bettercast can't confirm the destination accepted it — check before continuing."
							: "New copies don't change this queue. Each paste-next uses exactly one item."}
				</Text>
			</View>
			<ActionBar
				left={queue.reversed ? <Text className="darker-text text-xxs">Reversed order</Text> : null}
				actions={
					done
						? [
								{ label: "Restart", keys: ["⌘", "R"] },
								{ label: "Close", keys: ["esc"], primary: true },
							]
						: [
								{ label: "Reverse", keys: ["R"] },
								{ label: "Skip", keys: ["→"] },
								{ label: status === "running" ? "Pause" : "Resume", keys: ["space"], disabled: !active },
								{
									label: status === "interrupted" || status === "paused" ? "Resume" : "Paste next",
									keys: ["⏎"],
									primary: true,
								},
							]
				}
			/>
		</View>
	);
});

export const ClipboardQueueWidget: FC = observer(() => {
	const clip = useClipboardContract();
	if (!clip)
		return (
			<EmptyState
				glyph="⌧"
				title="Paste queue isn't available in this build"
				detail="The clipboard repository didn't load."
			/>
		);
	return <QueueView clip={clip} />;
});
