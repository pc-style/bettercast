import type { FC } from "react";
import { Clipboard, Text, TouchableOpacity, View } from "react-native";
import { splitSegments } from "ui/ai-view";

/** Model text with fenced code rendered as copyable monospace blocks. */
export const MessageText: FC<{ text: string; streaming?: boolean }> = ({ text, streaming }) => {
	const segments = splitSegments(text);
	return (
		<View className="gap-2">
			{segments.map((segment, i) => {
				const last = i === segments.length - 1;
				if (segment.type === "prose") {
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
						<Text key={i} selectable className="text text-sm leading-5">
							{segment.text}
							{streaming && last ? <Text className="text-accent-strong">▍</Text> : null}
						</Text>
					);
				}
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
					<View key={i} className="rounded-lg bg-neutral-900/90 dark:bg-black/50 overflow-hidden">
						<View className="flex-row items-center px-3 pt-1">
							<Text className="text-neutral-400 text-xxs flex-1">{segment.lang || "code"}</Text>
							{segment.closed ? (
								<TouchableOpacity
									onPress={() => Clipboard.setString(segment.text)}
									// @ts-expect-error macOS prop
									enableFocusRing={false}
								>
									<Text className="text-neutral-400 text-xxs">Copy</Text>
								</TouchableOpacity>
							) : (
								<Text className="text-neutral-500 text-xxs">streaming…</Text>
							)}
						</View>
						<Text selectable className="font-mono text-xs text-neutral-100 px-3 pb-2 pt-1">
							{segment.text}
						</Text>
					</View>
				);
			})}
			{streaming && !segments.length && <Text className="text-accent-strong text-sm">▍</Text>}
		</View>
	);
};
