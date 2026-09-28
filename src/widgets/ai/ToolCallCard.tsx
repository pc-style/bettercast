import clsx from "clsx";
import { StatusPill } from "components/StatusPill";
import type { ToolCall } from "contracts/ai";
import { type FC, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { formatArgs, SIDE_EFFECT, TOOL_STATE } from "ui/ai-view";

const RESULT_PREVIEW_LINES = 4;

/** Visible record of one tool invocation: what ran, where, with what, and what came back. */
export const ToolCallCard: FC<{ call: ToolCall }> = ({ call }) => {
	const [expanded, setExpanded] = useState(false);
	const state = TOOL_STATE[call.state];
	const result = call.result ?? "";
	const lines = result.split("\n");
	const long = lines.length > RESULT_PREVIEW_LINES || result.length > 400;
	const shown = expanded || !long ? result : `${lines.slice(0, RESULT_PREVIEW_LINES).join("\n").slice(0, 400)}…`;
	const duration =
		call.startedAt && call.finishedAt ? `${((call.finishedAt - call.startedAt) / 1000).toFixed(1)}s` : null;

	return (
		<View className="rounded-lg border border-color subBg px-3 py-2 gap-1 my-1">
			<View className="flex-row items-center gap-2">
				<StatusPill label={state.label} tone={state.tone} dot />
				<Text className="text text-xs font-semibold flex-1" numberOfLines={1}>
					<Text className="darker-text font-normal">{call.source.replace(/^(mcp|command):/, "")} › </Text>
					{call.tool}
				</Text>
				{call.sideEffects.map(effect => (
					<StatusPill key={effect} label={SIDE_EFFECT[effect].label} tone={SIDE_EFFECT[effect].tone} />
				))}
				{!!duration && <Text className="darker-text text-xxs">{duration}</Text>}
			</View>
			{!!call.destination && (
				<Text className="darker-text text-xxs" numberOfLines={1}>
					→ {call.destination}
				</Text>
			)}
			{Object.keys(call.args).length > 0 && (
				<Text className="font-mono text-xxs darker-text" numberOfLines={2}>
					{formatArgs(call.args)}
				</Text>
			)}
			{!!result && (
				<TouchableOpacity
					disabled={!long}
					onPress={() => setExpanded(e => !e)}
					// @ts-expect-error macOS prop
					enableFocusRing={false}
				>
					<View className="rounded bg-white/60 dark:bg-black/25 px-2 py-1 mt-1">
						<Text selectable className="font-mono text-xxs text">
							{shown}
						</Text>
						{long && (
							<Text className="text-accent-strong text-xxs mt-1">{expanded ? "Show less" : "Show full result"}</Text>
						)}
					</View>
				</TouchableOpacity>
			)}
			{!!call.error && (
				<Text selectable className={clsx("text-xxs", "text-red-600 dark:text-red-400")}>
					{call.error}
				</Text>
			)}
		</View>
	);
};
