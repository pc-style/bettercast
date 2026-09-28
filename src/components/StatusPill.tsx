import clsx from "clsx";
import type { FC } from "react";
import { Text, View } from "react-native";
import type { Tone } from "ui/clipboard-view";

const TONE_BG: Record<Tone, string> = {
	neutral: "bg-neutral-500/15",
	accent: "bg-accent",
	success: "bg-green-500/15",
	warning: "bg-amber-500/20",
	danger: "bg-red-500/15",
};

const TONE_TEXT: Record<Tone, string> = {
	neutral: "text-neutral-600 dark:text-neutral-300",
	accent: "text-white",
	success: "text-green-700 dark:text-green-400",
	warning: "text-amber-700 dark:text-amber-300",
	danger: "text-red-700 dark:text-red-400",
};

const TONE_DOT: Record<Tone, string> = {
	neutral: "bg-neutral-400",
	accent: "bg-white",
	success: "bg-green-500",
	warning: "bg-amber-500",
	danger: "bg-red-500",
};

export const toneText = (tone: Tone) => TONE_TEXT[tone];

type Props = {
	label: string;
	tone?: Tone;
	dot?: boolean;
	className?: string;
};

/** Small state label. Colour is never the only signal: the label always states the state. */
export const StatusPill: FC<Props> = ({ label, tone = "neutral", dot, className }) => (
	<View
		className={clsx(
			"flex-row items-center gap-1 rounded-full px-2 py-[1px]",
			TONE_BG[tone],
			className,
		)}
	>
		{dot && <View className={clsx("h-[6px] w-[6px] rounded-full", TONE_DOT[tone])} />}
		<Text className={clsx("text-xxs font-medium", TONE_TEXT[tone])} numberOfLines={1}>
			{label}
		</Text>
	</View>
);
