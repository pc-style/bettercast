import { Key } from "components/Key";
import { StatusPill } from "components/StatusPill";
import type { PendingApproval } from "contracts/ai";
import type { FC } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { formatArgs, SIDE_EFFECT } from "ui/ai-view";

const Choice: FC<{ label: string; keys: string[]; onPress: () => void; primary?: boolean }> = ({
	label,
	keys,
	onPress,
	primary,
}) => (
	<TouchableOpacity
		onPress={onPress}
		// @ts-expect-error macOS prop
		enableFocusRing={false}
	>
		<View
			className={
				primary
					? "flex-row items-center gap-1 rounded-md bg-accent-strong px-2 py-1"
					: "flex-row items-center gap-1 rounded-md bg-neutral-500/15 px-2 py-1"
			}
		>
			<Text className={primary ? "text-white text-xs font-medium mr-1" : "text text-xs mr-1"}>{label}</Text>
			{keys.map(k => (
				<Key key={k} symbol={k} />
			))}
		</View>
	</TouchableOpacity>
);

/**
 * Tool approval. Shows tool, destination, meaningful arguments and side effects. Keys are
 * deliberately not plain ⏎ so a message being typed can't approve by accident.
 */
export const ApprovalCard: FC<{
	approval: PendingApproval;
	onApprove: (scope: "once" | "conversation" | "always") => void;
	onDeny: () => void;
}> = ({ approval, onApprove, onDeny }) => {
	const { call, allowedScopes } = approval;
	const writes = call.sideEffects.some(e => e !== "read");
	return (
		<View className="mx-3 mb-2 rounded-xl border border-amber-500/50 bg-amber-500/10 px-3 py-2 gap-1">
			<View className="flex-row items-center gap-2">
				<Text className="text text-sm font-semibold flex-1" numberOfLines={1}>
					Allow <Text className="font-mono">{call.tool}</Text>
					<Text className="darker-text font-normal"> from {call.source.replace(/^(mcp|command):/, "")}?</Text>
				</Text>
				{call.sideEffects.map(effect => (
					<StatusPill key={effect} label={SIDE_EFFECT[effect].label} tone={SIDE_EFFECT[effect].tone} />
				))}
			</View>
			{!!call.destination && <Text className="text text-xs">→ {call.destination}</Text>}
			{Object.keys(call.args).length > 0 && (
				<Text selectable className="font-mono text-xxs darker-text" numberOfLines={3}>
					{formatArgs(call.args, 320)}
				</Text>
			)}
			<Text className="darker-text text-xxs">
				{writes
					? "This can change or send data outside Bettercast."
					: "Read-only, but the result goes to the model and may leave your Mac."}{" "}
				Bettercast enforces this decision; the model can't approve itself.
			</Text>
			<View className="flex-row items-center gap-2 pt-1">
				<Choice label="Deny" keys={["esc"]} onPress={onDeny} />
				<View className="flex-1" />
				{allowedScopes.includes("conversation") && (
					<Choice label="Allow in this chat" keys={["⌘", "⇧", "⏎"]} onPress={() => onApprove("conversation")} />
				)}
				{allowedScopes.includes("once") && (
					<Choice label="Allow once" keys={["⌘", "⏎"]} onPress={() => onApprove("once")} primary />
				)}
			</View>
		</View>
	);
};
