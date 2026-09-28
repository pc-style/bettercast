import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import clsx from "clsx";
import { ActionBar } from "components/ActionBar";
import { ActionPanel, type PanelAction } from "components/ActionPanel";
import { EmptyState } from "components/EmptyState";
import { FileIcon } from "components/FileIcon";
import { FilterTabs } from "components/FilterTabs";
import { MainInput } from "components/MainInput";
import { Notice } from "components/Notice";
import { QueueIndicator } from "components/QueueIndicator";
import { StatusPill } from "components/StatusPill";
import type { ClipAction, ClipboardContract, ClipItem } from "contracts/clipboard";
import { solNative } from "lib/SolNative";
import { observer } from "mobx-react-lite";
import { type FC, useEffect, useMemo, useRef, useState } from "react";
import { Image, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useStore } from "store";
import { Widget } from "stores/ui.store";
import {
	captureLabel,
	deliveryMessage,
	KIND_FILTERS,
	KIND_GLYPH,
	KIND_LABEL,
	looksLikeCode,
	retentionSummary,
	rowTitle,
	sinceFor,
	sourceLabel,
	TIME_FILTERS,
} from "ui/clipboard-view";
import { absoluteTime, formatBytes, relativeTime } from "ui/format";
import { useClipboardContract, useKeyHandler, useNativeKeyCapture, useNow } from "ui/hooks";
import { digitIndex, KEY } from "ui/keys";
import { clampSelection, moveSelection, shouldLoadMore, toggleOrdered } from "ui/selection";

const toFileUri = (path: string) => path.startsWith("data:") || path.startsWith("file:") ? path : encodeURI(`file://${path}`);

const Thumb: FC<{ item: ClipItem; size: number }> = ({ item, size }) => {
	if (item.kind === "image" && (item.thumbnailPath || item.path) && item.available) {
		return (
			<Image
				source={{ uri: toFileUri((item.thumbnailPath ?? item.path) as string) }}
				style={{ width: size, height: size, borderRadius: 4 }}
				resizeMode="cover"
			/>
		);
	}
	if (item.kind === "file" && item.path && item.available) {
		return <FileIcon url={item.path} style={{ width: size, height: size }} />;
	}
	return (
		<View
			style={{ width: size, height: size }}
			className="items-center justify-center rounded bg-neutral-500/10"
		>
			<Text className="darker-text text-xs">{KIND_GLYPH[item.kind]}</Text>
		</View>
	);
};

const Row: FC<{
	item: ClipItem;
	active: boolean;
	mark: number;
	now: number;
	onPress: () => void;
}> = ({ item, active, mark, now, onPress }) => {
	const source = sourceLabel(item);
	return (
		<TouchableOpacity
			onPress={onPress}
			// @ts-expect-error macOS prop
			enableFocusRing={false}
		>
			<View
				className={clsx("flex-row items-center gap-2 rounded-lg px-2 h-[42px]", {
					"bg-accent": active,
				})}
			>
				<Thumb item={item} size={24} />
				<View className="flex-1 gap-[1px]">
					<Text
						numberOfLines={1}
						className={clsx("text-sm", {
							"text-white": active,
							text: !active,
							"line-through opacity-60": !item.available,
						})}
					>
						{rowTitle(item)}
					</Text>
					<Text
						numberOfLines={1}
						className={clsx("text-xxs", {
							"text-white/80": active,
							"darker-text": !active,
						})}
					>
						{[source, relativeTime(item.copiedAt, now), !item.available ? "Missing" : null]
							.filter(Boolean)
							.join(" · ")}
					</Text>
				</View>
				{item.pinned && (
					<Text className={clsx("text-xxs", active ? "text-white" : "darker-text")}>Pinned</Text>
				)}
				{mark > 0 && (
					<View className="h-[18px] min-w-[18px] px-1 items-center justify-center rounded-full bg-accent-strong">
						<Text className="text-white text-xxs font-bold">{mark}</Text>
					</View>
				)}
			</View>
		</TouchableOpacity>
	);
};

const MetaRow: FC<{ label: string; value?: string }> = ({ label, value }) =>
	value ? (
		<View className="flex-row gap-3 py-[3px]">
			<Text className="darker-text text-xs w-16">{label}</Text>
			<Text className="text text-xs flex-1" numberOfLines={2} selectable>
				{value}
			</Text>
		</View>
	) : null;

const Detail: FC<{ item: ClipItem; now: number }> = ({ item, now }) => {
	const code = item.kind === "text" && looksLikeCode(item.preview);
	return (
		<View className="flex-1 gap-2">
			<View className="flex-1 rounded-lg bg-white dark:bg-black/20 border border-color overflow-hidden">
				{item.kind === "image" && item.available && item.path ? (
					<Image
						source={{ uri: toFileUri(item.path) }}
						style={StyleSheet.absoluteFill}
						resizeMode="contain"
					/>
				) : item.kind === "file" ? (
					<View className="flex-1 items-center justify-center gap-2 p-4">
						{item.available && item.path ? (
							<FileIcon url={item.path} style={{ width: 64, height: 64 }} />
						) : (
							<Text className="text-4xl text-neutral-300 dark:text-neutral-600">▤</Text>
						)}
						<Text className="text text-sm font-medium text-center" numberOfLines={2}>
							{item.preview}
						</Text>
					</View>
				) : (
					<ScrollView contentContainerStyle={{ padding: 12 }}>
						<Text
							selectable
							className={clsx("text", {
								"font-mono text-xs": code,
								"text-sm": !code,
							})}
						>
							{item.preview}
						</Text>
					</ScrollView>
				)}
			</View>
			{item.previewTruncated && item.available && (
				<Text className="darker-text text-xxs px-1">Preview shortened · paste and copy use the full content</Text>
			)}
			{!item.available && (
				<Notice
					tone="danger"
					title={item.kind === "file" ? "File no longer available" : "Original payload missing"}
					detail={item.path ? `${item.path} can't be read. Paste is disabled for this item.` : "Paste is disabled for this item."}
				/>
			)}
			<View className="px-1">
				<MetaRow label="Type" value={KIND_LABEL[item.kind]} />
				<MetaRow
					label="Source"
					value={
						item.sourceApp
							? `${item.sourceApp.name}${item.sourceApp.evidence === "inferred" ? " — inferred, not reported by macOS" : ""}`
							: "Unknown"
					}
				/>
				<MetaRow label="Copied" value={`${absoluteTime(item.copiedAt)} · ${relativeTime(item.copiedAt, now)}`} />
				<MetaRow label="Size" value={item.byteSize != null ? formatBytes(item.byteSize) : undefined} />
				<MetaRow label="Path" value={item.kind !== "text" ? item.path : undefined} />
			</View>
		</View>
	);
};

const Unavailable = () => {
	return (
		<View className="flex-1">
			<View className="flex-row px-3">
				<MainInput placeholder="Search clipboard…" showBackButton />
			</View>
			<View className="flex-1 border-t border-color">
				<EmptyState
					glyph="⌧"
					title="Clipboard history isn't available in this build"
					detail="The clipboard repository didn't load, so nothing is being captured or shown. Your other launcher features still work."
				/>
			</View>
			<ActionBar actions={[{ label: "Back", keys: ["esc"] }]} />
		</View>
	);
};

const ClipboardView: FC<{ clip: ClipboardContract }> = observer(({ clip }) => {
	const { ui } = useStore();
	const now = useNow(30_000);
	const [kindFilter, setKindFilter] = useState(0);
	const [timeFilter, setTimeFilter] = useState(0);
	const [index, setIndex] = useState(0);
	const [marks, setMarks] = useState<string[]>([]);
	const [panelOpen, setPanelOpen] = useState(false);
	const listRef = useRef<LegendListRef | null>(null);
	const items = clip.page.items;
	const selected: ClipItem | undefined = items[clampSelection(index, items.length)];

	useNativeKeyCapture({ enter: true, vertical: true });

	// Reload page 1 whenever the query or filters change (debounced while typing).
	useEffect(() => {
		const id = setTimeout(() => {
			void clip.load({
				text: ui.query,
				kinds: KIND_FILTERS[kindFilter].kinds,
				since: sinceFor(timeFilter, Date.now()),
			});
			setIndex(0);
		}, 60);
		return () => clearTimeout(id);
	}, [clip, ui.query, kindFilter, timeFilter]);

	useEffect(() => {
		if (items.length) listRef.current?.scrollToIndex({ index: clampSelection(index, items.length), viewOffset: 80 });
		if (shouldLoadMore(index, items.length, clip.page.hasMore, clip.loading)) void clip.loadMore();
	}, [index, items.length, clip]);

	const run = (action: ClipAction, item: ClipItem | undefined = selected) => {
		if (!item) return;
		void clip.act(item.id, action).then(result => {
			const message = deliveryMessage(result);
			if (message) solNative.showToast(message.text, message.tone === "success" ? "success" : "error");
			if (action === "delete") setMarks(m => m.filter(id => id !== item.id));
		});
	};

	const startQueue = () => {
		if (!marks.length) return;
		clip.queueStart(marks);
		setMarks([]);
		ui.focusWidget(Widget.CLIPBOARD_QUEUE);
	};

	const actions: PanelAction[] = useMemo(() => {
		const item = selected;
		const missing = item && !item.available ? "The original is no longer available" : undefined;
		const list: PanelAction[] = [
			{ id: "paste", label: "Paste", keys: ["⏎"], disabledReason: missing, run: () => run("paste") },
			{
				id: "plain",
				label: "Paste as plain text",
				keys: ["⇧", "⏎"],
				disabledReason: missing ?? (item?.kind === "image" ? "Images have no plain-text form" : undefined),
				run: () => run("pastePlain"),
			},
			{ id: "copy", label: "Copy without pasting", keys: ["⌘", "⇧", "C"], disabledReason: missing, run: () => run("copy") },
			{
				id: "mark",
				label: item && marks.includes(item.id) ? "Remove from queue" : "Add to paste queue",
				keys: ["⇥"],
				disabledReason: missing,
				run: () => item && setMarks(m => toggleOrdered(m, item.id)),
			},
			{
				id: "queue",
				label: marks.length ? `Start queue (${marks.length})` : "Start queue",
				keys: ["⌘", "⏎"],
				disabledReason: marks.length ? undefined : "Mark items with ⇥ first",
				run: startQueue,
			},
		];
		if (item?.kind === "image")
			list.push({ id: "save", label: "Save image…", keys: ["⌘", "S"], disabledReason: missing, run: () => run("saveImage") });
		if (item?.kind === "file" || item?.kind === "image")
			list.push({ id: "reveal", label: "Reveal in Finder", keys: ["⌘", "R"], disabledReason: missing, run: () => run("reveal") });
		list.push(
			{ id: "pin", label: item?.pinned ? "Unpin" : "Pin", keys: ["⌘", "P"], run: () => run(item?.pinned ? "unpin" : "pin") },
			{ id: "delete", label: "Delete from history", keys: ["⇧", "⌫"], tone: "danger", run: () => run("delete") },
			{
				id: "privacy",
				label: "Capture & privacy settings",
				keys: ["⌘", ","],
				run: () => ui.focusWidget(Widget.PRIVACY),
			},
		);
		return list;
	}, [selected, marks]);

	useKeyHandler(({ keyCode, meta, shift }) => {
		const digit = meta ? digitIndex(keyCode) : undefined;
		if (digit != null && digit < KIND_FILTERS.length) {
			setKindFilter(digit);
			return true;
		}
		switch (keyCode) {
			case KEY.DOWN:
			case KEY.UP:
				setIndex(i => moveSelection(i, keyCode === KEY.DOWN ? 1 : -1, items.length));
				return true;
			case KEY.ENTER:
				if (meta) startQueue();
				else if (selected?.available) run(shift ? "pastePlain" : "paste");
				return true;
			case KEY.TAB:
				if (selected?.available) setMarks(m => toggleOrdered(m, selected.id));
				return true;
			case KEY.K:
				if (!meta) return false;
				setPanelOpen(true);
				return true;
			case KEY.T:
				if (!meta) return false;
				setTimeFilter(t => (t + 1) % TIME_FILTERS.length);
				return true;
			case KEY.C:
				if (!(meta && shift)) return false;
				run("copy");
				return true;
			case KEY.S:
				if (!meta || selected?.kind !== "image") return false;
				run("saveImage");
				return true;
			case KEY.R:
				if (!meta || !(selected?.kind === "file" || selected?.kind === "image")) return false;
				run("reveal");
				return true;
			case KEY.P:
				if (!meta || !selected) return false;
				run(selected.pinned ? "unpin" : "pin");
				return true;
			case KEY.COMMA:
				if (!meta) return false;
				ui.focusWidget(Widget.PRIVACY);
				return true;
			case KEY.DELETE:
				if (!shift) return false;
				run("delete");
				return true;
		}
		return false;
	}, !panelOpen);

	const capture = captureLabel(clip.capture, now);
	const retention = clip.retention ? retentionSummary(clip.retention) : null;
	const captureProblem = clip.capture.status !== "capturing";

	return (
		<View className="flex-1">
			<View className="flex-row items-center px-3">
				<MainInput placeholder="Search clipboard…" showBackButton />
				<StatusPill label={capture.label} tone={capture.tone} dot />
			</View>
			<View className="flex-row items-center gap-3 px-3 pb-2">
				<FilterTabs
					options={KIND_FILTERS.map(f => f.label)}
					selected={kindFilter}
					onSelect={setKindFilter}
					shortcutPrefix="⌘"
				/>
				<View className="flex-1" />
				<TouchableOpacity
					onPress={() => setTimeFilter(t => (t + 1) % TIME_FILTERS.length)}
					// @ts-expect-error macOS prop
					enableFocusRing={false}
				>
					<Text className="darker-text text-xs">
						{TIME_FILTERS[timeFilter].label} <Text className="text-xxs">⌘T</Text>
					</Text>
				</TouchableOpacity>
			</View>
			<View
				className={clsx("h-[1px]", clip.loading ? "bg-accent-strong" : "bg-lightBorder dark:bg-darkBorder")}
			/>
			{(captureProblem || retention?.conflict || clip.loadError) && (
				<View className="px-3 pt-2 gap-2">
					{!!clip.loadError && <Notice tone="danger" title="History failed to load" detail={clip.loadError} />}
					{captureProblem && <Notice tone={capture.tone} title={capture.label} detail={capture.detail} />}
					{retention?.conflict && <Notice tone="warning" title="Storage cap is shortening history" detail={retention.text} />}
				</View>
			)}
			<View className="flex-1 flex-row">
				<View className="w-[292px]">
					<LegendList
						ref={listRef}
						data={items}
						keyExtractor={item => item.id}
						estimatedItemSize={42}
						contentContainerStyle={STYLES.list}
						recycleItems
						renderItem={({ item, index: i }: { item: ClipItem; index: number }) => (
							<Row
								item={item}
								now={now}
								active={i === index}
								mark={marks.indexOf(item.id) + 1}
								onPress={() => setIndex(i)}
							/>
						)}
						ListEmptyComponent={
							clip.loading ? null : (
								<EmptyState
									glyph="⌕"
									title={ui.query || kindFilter || timeFilter ? "No matches" : "No clipboard history yet"}
									detail={
										ui.query || kindFilter || timeFilter
											? "Try fewer words, another type, or a wider time range."
											: captureProblem
												? "Capture is not running, so nothing new is recorded."
												: "Copy some text or an image and it will appear here."
									}
								/>
							)
						}
					/>
				</View>
				<View className="flex-1 pr-3 py-2">
					{selected ? <Detail item={selected} now={now} /> : null}
				</View>
			</View>
			<ActionBar
				left={
					marks.length ? (
						<Text className="text text-xs">
							{marks.length} marked · <Text className="darker-text">⌘⏎ start queue</Text>
						</Text>
					) : clip.queue.state.status !== "idle" ? (
						<QueueIndicator queue={clip.queue} />
					) : retention ? (
						<Text className="darker-text text-xxs" numberOfLines={1}>
							{retention.text}
						</Text>
					) : null
				}
				actions={[
					{ label: "Actions", keys: ["⌘", "K"] },
					{ label: "Mark", keys: ["⇥"] },
					{ label: "Paste", keys: ["⏎"], primary: true, disabled: !selected?.available },
				]}
			/>
			{panelOpen && (
				<ActionPanel title={selected ? rowTitle(selected).slice(0, 40) : "Clipboard"} actions={actions} onClose={() => setPanelOpen(false)} />
			)}
		</View>
	);
});

export const ClipboardWidget: FC = observer(() => {
	const clip = useClipboardContract();
	return clip ? <ClipboardView clip={clip} /> : <Unavailable />;
});

const STYLES = StyleSheet.create({
	list: { flexGrow: 1, paddingVertical: 6, paddingLeft: 8, paddingRight: 4 },
});
