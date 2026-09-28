import clsx from "clsx";
import { observer } from "mobx-react-lite";
import { type FC, useEffect, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import type { Tone } from "ui/clipboard-view";
import { useKeyHandler, useNativeKeyCapture } from "ui/hooks";
import { KEY } from "ui/keys";
import { moveSelection } from "ui/selection";
import { Key } from "./Key";

export type PanelAction = {
	id: string;
	label: string;
	/** Direct shortcut glyphs shown for learning; the owning widget handles them. */
	keys?: string[];
	tone?: Tone;
	/** When set, the action is shown disabled with this reason instead of hidden. */
	disabledReason?: string;
	run: () => void;
};

type Props = {
	title: string;
	actions: PanelAction[];
	onClose: () => void;
};

/**
 * ⌘K secondary actions. Owns keys while open: ↑↓ / ⌃N ⌃P / Tab move, ⏎ runs, Esc or ⌘K closes.
 * Disabled actions stay visible with a reason so capabilities are never silently missing.
 */
export const ActionPanel: FC<Props> = observer(({ title, actions, onClose }) => {
	const [index, setIndex] = useState(() => {
		const first = actions.findIndex(a => !a.disabledReason);
		return first < 0 ? 0 : first;
	});
	useEffect(() => {
		setIndex(i => moveSelection(i, 0, actions.length));
	}, [actions.length]);

	useNativeKeyCapture({ enter: true, vertical: true });
	useKeyHandler(({ keyCode, meta, shift, control }) => {
		const down = keyCode === KEY.DOWN || (control && (keyCode === KEY.N || keyCode === KEY.J)) || (keyCode === KEY.TAB && !shift);
		const up = keyCode === KEY.UP || (control && (keyCode === KEY.P || keyCode === KEY.K)) || (keyCode === KEY.TAB && shift);
		if (down || up) {
			setIndex(i => moveSelection(i, down ? 1 : -1, actions.length));
			return true;
		}
		if (keyCode === KEY.ENTER) {
			const action = actions[index];
			if (action && !action.disabledReason) {
				onClose();
				action.run();
			}
			return true;
		}
		if (keyCode === KEY.ESC || (meta && keyCode === KEY.K)) {
			onClose();
			return true;
		}
		// Swallow everything else so keys don't leak to the widget underneath.
		return true;
	});

	const selected = actions[index];

	return (
		<View className="absolute top-0 bottom-0 left-0 right-0" pointerEvents="box-none">
			<TouchableOpacity
				className="absolute top-0 bottom-0 left-0 right-0"
				onPress={onClose}
				// @ts-expect-error macOS prop
				enableFocusRing={false}
			/>
			<View className="absolute right-3 bottom-12 w-[300px] rounded-xl border border-window bg-white dark:bg-neutral-800 shadow-lg py-1">
				<Text className="darker-text text-xxs font-semibold uppercase px-3 pt-1 pb-1">{title}</Text>
				{actions.map((action, i) => {
					const active = i === index;
					const disabled = !!action.disabledReason;
					return (
						<TouchableOpacity
							key={action.id}
							disabled={disabled}
							onPress={() => {
								onClose();
								action.run();
							}}
							// @ts-expect-error macOS prop
							enableFocusRing={false}
						>
							<View
								className={clsx("mx-1 flex-row items-center gap-2 rounded-md px-2 h-8", {
									"bg-accent": active,
								})}
							>
								<Text
									numberOfLines={1}
									className={clsx("flex-1 text-sm", {
										"text-white": active && !disabled,
										text: !active && !disabled && action.tone !== "danger",
										"text-red-600 dark:text-red-400": !active && !disabled && action.tone === "danger",
										"text-neutral-400 dark:text-neutral-500": disabled,
									})}
								>
									{action.label}
								</Text>
								{!!action.keys && (
									<View className="flex-row gap-[3px]">
										{action.keys.map(k => (
											<Key key={k} symbol={k} />
										))}
									</View>
								)}
							</View>
						</TouchableOpacity>
					);
				})}
				{!!selected?.disabledReason && (
					<Text className="darker-text text-xxs px-3 pt-1 pb-1">{selected.disabledReason}</Text>
				)}
			</View>
		</View>
	);
});
