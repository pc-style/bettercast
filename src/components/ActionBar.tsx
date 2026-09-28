import clsx from "clsx";
import { Fragment, type FC, type ReactNode } from "react";
import { Text, View } from "react-native";
import { Key } from "./Key";

export type BarAction = {
	label: string;
	keys: string[];
	primary?: boolean;
	disabled?: boolean;
};

type Props = {
	actions: BarAction[];
	/** Left side status (queue, capture state, counts). */
	left?: ReactNode;
};

/** Footer shortcut bar shared by every widget; matches Sol's search footer. */
export const ActionBar: FC<Props> = ({ actions, left }) => (
	<View className="py-2 px-4 flex-row items-center gap-1 subBg border-t border-color">
		<View className="flex-1 flex-row items-center gap-2 overflow-hidden">{left}</View>
		{actions.map((action, index) => (
			<Fragment key={action.label}>
				{index > 0 && <View className="mx-2" />}
				<Text
					className={clsx("text-xs mr-1", {
						"darker-text": !action.primary,
						"text font-medium": action.primary,
						"opacity-40": action.disabled,
					})}
				>
					{action.label}
				</Text>
				{action.keys.map((symbol, i) => (
					<Key
						// biome-ignore lint/suspicious/noArrayIndexKey: static key glyph list
						key={`${symbol}${i}`}
						symbol={symbol}
						primary={action.primary && !action.disabled && i === action.keys.length - 1}
					/>
				))}
			</Fragment>
		))}
	</View>
);
