import clsx from "clsx";
import type { Attachment, ProviderInfo } from "contracts/ai";
import type { FC } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { ATTACHMENT_STATUS, kindSupported } from "ui/ai-view";
import { formatBytes } from "ui/format";

const ORIGIN: Record<Attachment["origin"], string> = {
	file: "File",
	paste: "Pasted",
	clipboard: "Clipboard",
	selection: "Selection",
};

/** Everything that will accompany the prompt, with per-item status. Click × to remove. */
export const ContextTray: FC<{
	attachments: Attachment[];
	provider?: ProviderInfo;
	onRemove: (id: string) => void;
}> = ({ attachments, provider, onRemove }) => {
	if (!attachments.length) return null;
	return (
		<View className="flex-row flex-wrap gap-1 px-3 pb-1">
			{attachments.map(a => {
				const status = ATTACHMENT_STATUS[a.status];
				const unsupported = provider && a.status === "ready" && !kindSupported(provider, a);
				const bad = status.blocks || unsupported;
				return (
					<View
						key={a.id}
						className={clsx("flex-row items-center gap-1 rounded-md border px-2 py-[2px] max-w-[320px]", {
							"border-color subBg": !bad && a.status !== "truncated",
							"border-amber-500/50 bg-amber-500/10": a.status === "truncated",
							"border-red-500/50 bg-red-500/10": bad,
						})}
					>
						<Text className="darker-text text-xxs">{ORIGIN[a.origin]}</Text>
						<Text className="text text-xs flex-shrink" numberOfLines={1}>
							{a.name}
						</Text>
						<Text className="darker-text text-xxs">
							{formatBytes(a.sentBytes ?? a.bytes)}
							{bad ? ` · ${unsupported ? `${provider?.label} can't read this` : status.label}` : ""}
							{a.status === "truncated" ? " · truncated" : ""}
						</Text>
						<TouchableOpacity
							onPress={() => onRemove(a.id)}
							// @ts-expect-error macOS prop
							enableFocusRing={false}
						>
							<Text className="darker-text text-xs px-[2px]">×</Text>
						</TouchableOpacity>
					</View>
				);
			})}
		</View>
	);
};
