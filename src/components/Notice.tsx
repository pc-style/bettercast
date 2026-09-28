import clsx from "clsx";
import type { FC, ReactNode } from "react";
import { Text, View } from "react-native";
import type { Tone } from "ui/clipboard-view";
import { toneText } from "./StatusPill";

const BORDER: Record<Tone, string> = {
	neutral: "border-color",
	accent: "border-color",
	success: "border-green-500/30",
	warning: "border-amber-500/40",
	danger: "border-red-500/40",
};

const BG: Record<Tone, string> = {
	neutral: "subBg",
	accent: "subBg",
	success: "bg-green-500/10",
	warning: "bg-amber-500/10",
	danger: "bg-red-500/10",
};

type Props = {
	tone?: Tone;
	title: string;
	detail?: string;
	/** Right-aligned hint, e.g. <Key symbol="⌘"/> */
	right?: ReactNode;
	className?: string;
};

/** Inline state banner for permission, capture, provider and storage problems. */
export const Notice: FC<Props> = ({ tone = "neutral", title, detail, right, className }) => (
	<View
		className={clsx(
			"flex-row items-center gap-3 rounded-lg border px-3 py-2",
			BORDER[tone],
			BG[tone],
			className,
		)}
	>
		<View className="flex-1 gap-[2px]">
			<Text className={clsx("text-xs font-semibold", tone === "neutral" ? "text" : toneText(tone))}>
				{title}
			</Text>
			{!!detail && <Text className="text-xs darker-text">{detail}</Text>}
		</View>
		{right}
	</View>
);
