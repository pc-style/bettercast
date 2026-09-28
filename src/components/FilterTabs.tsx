import clsx from "clsx";
import type { FC } from "react";
import { Text, TouchableOpacity, View } from "react-native";

type Props = {
	options: string[];
	selected: number;
	onSelect: (index: number) => void;
	/** Show ⌘1…⌘n hints on hover-free keyboard use. */
	shortcutPrefix?: string;
};

/** Compact segmented filter. Selected state is shown by fill and weight, not colour alone. */
export const FilterTabs: FC<Props> = ({ options, selected, onSelect, shortcutPrefix }) => (
	<View className="flex-row items-center gap-1">
		{options.map((label, index) => {
			const active = index === selected;
			return (
				<TouchableOpacity
					key={label}
					onPress={() => onSelect(index)}
					// @ts-expect-error macOS prop
					enableFocusRing={false}
				>
					<View
						className={clsx("flex-row items-center gap-1 rounded-md px-2 py-[3px]", {
							"bg-accent": active,
						})}
					>
						<Text
							className={clsx("text-xs", {
								"text-white font-semibold": active,
								"darker-text": !active,
							})}
						>
							{label}
						</Text>
						{!!shortcutPrefix && (
							<Text
								className={clsx("text-xxs", {
									"text-white/70": active,
									"text-neutral-400 dark:text-neutral-500": !active,
								})}
							>
								{shortcutPrefix}
								{index + 1}
							</Text>
						)}
					</View>
				</TouchableOpacity>
			);
		})}
	</View>
);
