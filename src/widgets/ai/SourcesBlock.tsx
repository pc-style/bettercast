import type { Citation } from "contracts/ai";
import type { FC } from "react";
import { Linking, Text, TouchableOpacity, View } from "react-native";
import { hostOf } from "ui/ai-view";
import { relativeTime } from "ui/format";

/** Fetched evidence, kept visually separate from the model's own text. */
export const SourcesBlock: FC<{ citations: Citation[]; failures?: string[]; now: number }> = ({
	citations,
	failures,
	now,
}) => (
	<View className="rounded-lg border border-color px-3 py-2 my-1 gap-1">
		<Text className="darker-text text-xxs font-semibold uppercase">
			Web sources · {citations.length ? `${citations.length} fetched` : "none retrieved"}
		</Text>
		{citations.map((c, i) => (
			<TouchableOpacity
				key={`${c.url}-${i}`}
				onPress={() => Linking.openURL(c.url)}
				// @ts-expect-error macOS prop
				enableFocusRing={false}
			>
				<View className="flex-row items-baseline gap-2">
					<Text className="darker-text text-xxs w-4 text-right">{i + 1}</Text>
					<Text className="text text-xs flex-1" numberOfLines={1}>
						{c.title || hostOf(c.url)}
						<Text className="darker-text">
							{"  "}
							{hostOf(c.url)}
							{c.fetchedAt ? ` · fetched ${relativeTime(c.fetchedAt, now)}` : ""}
						</Text>
					</Text>
				</View>
			</TouchableOpacity>
		))}
		{failures?.map(f => (
			<Text key={f} className="text-xxs text-amber-700 dark:text-amber-300">
				Couldn't fetch: {f}
			</Text>
		))}
	</View>
);
