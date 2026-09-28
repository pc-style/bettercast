import clsx from "clsx";
import type { Attachment, AttachmentPreview, ProviderInfo } from "contracts/ai";
import { type FC, useState } from "react";
import { Image, ScrollView, Text, TouchableOpacity, View } from "react-native";
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
	preview?: (id: string) => AttachmentPreview | null;
}> = ({ attachments, provider, onRemove, preview }) => {
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const selected = attachments.find((a) => a.id === selectedId);
	const content = selected && preview?.(selected.id);
	if (!attachments.length) return null;
	return (
		<View className="px-3 pb-1 gap-1">
			<View className="flex-row flex-wrap gap-1">
				{attachments.map((a) => {
					const status = ATTACHMENT_STATUS[a.status];
					const unsupported =
						provider && a.status === "ready" && !kindSupported(provider, a);
					const bad = status.blocks || unsupported;
					return (
						<View
							key={a.id}
							className={clsx(
								"flex-row items-center gap-1 rounded-md border px-2 py-[2px] max-w-[320px]",
								{
									"border-color subBg": !bad && a.status !== "truncated",
									"border-amber-500/50 bg-amber-500/10":
										a.status === "truncated",
									"border-red-500/50 bg-red-500/10": bad,
								},
							)}
						>
							<Text className="darker-text text-xxs">{ORIGIN[a.origin]}</Text>
							<TouchableOpacity
								className="flex-shrink"
								accessibilityLabel={`Preview ${a.name}`}
								accessibilityState={{ expanded: selectedId === a.id }}
								onPress={() => setSelectedId(selectedId === a.id ? null : a.id)}
							>
								<Text className="text text-xs flex-shrink" numberOfLines={1}>
									{a.name}
								</Text>
							</TouchableOpacity>
							<Text className="darker-text text-xxs">
								{formatBytes(a.sentBytes ?? a.bytes)}
								{bad
									? ` · ${unsupported ? `${provider?.label} can't read this` : status.label}`
									: ""}
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
			{selected && (
				<View className="subBg border border-color rounded-md p-2 gap-1">
					<View className="flex-row justify-between gap-2">
						<Text className="darker-text text-xxs flex-1">
							{content?.truncated
								? "Preview shortened to 6,000 characters; sending uses the full loaded text."
								: "Loaded content preview"}
						</Text>
						<TouchableOpacity
							onPress={() => setSelectedId(null)}
							accessibilityLabel="Close attachment preview"
						>
							<Text className="darker-text text-xs">Close</Text>
						</TouchableOpacity>
					</View>
					{content?.imageUri ? (
						<Image
							source={{ uri: content.imageUri }}
							resizeMode="contain"
							style={{ height: 100, width: "100%" }}
							accessibilityLabel={selected.name}
						/>
					) : (
						<ScrollView style={{ maxHeight: 100 }}>
							<Text selectable className="text text-xs">
								{content?.text ??
									selected.note ??
									"Content preview unavailable for this attachment."}
							</Text>
						</ScrollView>
					)}
				</View>
			)}
		</View>
	);
};
