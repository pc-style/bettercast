import type { FC, ReactNode } from "react";
import { Text, View } from "react-native";

type Props = {
	glyph?: string;
	title: string;
	detail?: string;
	children?: ReactNode;
};

export const EmptyState: FC<Props> = ({ glyph = "[ ]", title, detail, children }) => (
	<View className="flex-1 items-center justify-center gap-2 px-8">
		<Text className="text-neutral-300 dark:text-neutral-600 text-4xl font-thin">{glyph}</Text>
		<Text className="text text-sm font-medium text-center">{title}</Text>
		{!!detail && (
			<Text className="darker-text text-xs text-center max-w-[380px]">{detail}</Text>
		)}
		{children}
	</View>
);
