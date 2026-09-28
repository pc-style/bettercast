import clsx from "clsx";
import type { ProviderInfo } from "contracts/ai";
import { type FC, useMemo, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { capabilityChips } from "ui/ai-view";
import { useKeyHandler, useNativeKeyCapture } from "ui/hooks";
import { KEY } from "ui/keys";
import { moveSelection } from "ui/selection";

type Option = { provider: ProviderInfo; modelId: string | null; label: string };

/** ⌘P provider/model chooser with honest availability, access method, capabilities and cost note. */
export const ProviderPicker: FC<{
	providers: ProviderInfo[];
	providerId: string | null;
	modelId: string | null;
	onSelect: (providerId: string, modelId: string | null) => void;
	onClose: () => void;
}> = ({ providers, providerId, modelId, onSelect, onClose }) => {
	const options: Option[] = useMemo(
		() =>
			providers.flatMap((provider): Option[] =>
				provider.models.length
					? provider.models.map(m => ({ provider, modelId: m.id, label: m.label }))
					: [{ provider, modelId: null, label: "Default model" }],
			),
		[providers],
	);
	const [index, setIndex] = useState(() =>
		Math.max(
			0,
			options.findIndex(o => o.provider.id === providerId && (o.modelId === modelId || !modelId)),
		),
	);
	const current = options[index];

	useNativeKeyCapture({ enter: true, vertical: true });
	useKeyHandler(({ keyCode, meta, control }) => {
		if (keyCode === KEY.DOWN || keyCode === KEY.UP || (control && (keyCode === KEY.N || keyCode === KEY.P))) {
			const down = keyCode === KEY.DOWN || keyCode === KEY.N;
			setIndex(i => moveSelection(i, down ? 1 : -1, options.length));
			return true;
		}
		if (keyCode === KEY.ENTER) {
			if (current?.provider.available) {
				onSelect(current.provider.id, current.modelId);
				onClose();
			}
			return true;
		}
		if (keyCode === KEY.ESC || (meta && keyCode === KEY.P)) {
			onClose();
			return true;
		}
		return true;
	});

	return (
		<View className="absolute top-0 bottom-0 left-0 right-0 bg-black/20 items-center pt-12">
			<View className="w-[440px] rounded-xl border border-window bg-white dark:bg-neutral-800 shadow-lg overflow-hidden">
				<Text className="darker-text text-xxs font-semibold uppercase px-3 pt-2 pb-1">Provider & model</Text>
				{!options.length && (
					<Text className="darker-text text-xs px-3 pb-3">
						No AI providers were detected. Bettercast only uses providers you've installed or configured.
					</Text>
				)}
				{options.map((o, i) => {
					const active = i === index;
					const firstOfProvider = i === 0 || options[i - 1].provider.id !== o.provider.id;
					const chosen = o.provider.id === providerId && (o.modelId === modelId || (!modelId && !o.modelId));
					return (
						<View key={`${o.provider.id}:${o.modelId}`}>
							{firstOfProvider && (
								<View className="flex-row items-center gap-2 px-3 pt-2">
									<Text className="text text-xs font-semibold">{o.provider.label}</Text>
									<Text className="darker-text text-xxs flex-1" numberOfLines={1}>
										{o.provider.accessMethod}
									</Text>
									{!o.provider.available && (
										<Text className="text-red-600 dark:text-red-400 text-xxs">Unavailable</Text>
									)}
								</View>
							)}
							<TouchableOpacity
								disabled={!o.provider.available}
								onPress={() => {
									onSelect(o.provider.id, o.modelId);
									onClose();
								}}
								// @ts-expect-error macOS prop
								enableFocusRing={false}
							>
								<View
									className={clsx("mx-1 flex-row items-center rounded-md px-3 h-8", {
										"bg-accent": active,
										"opacity-50": !o.provider.available,
									})}
								>
									<Text className={clsx("flex-1 text-sm", active ? "text-white" : "text")}>{o.label}</Text>
									{chosen && <Text className={clsx("text-xs", active ? "text-white" : "darker-text")}>Current</Text>}
								</View>
							</TouchableOpacity>
						</View>
					);
				})}
				{!!current && (
					<View className="border-t border-color mt-2 px-3 py-2 gap-1 subBg">
						<View className="flex-row flex-wrap gap-x-3 gap-y-1">
							{capabilityChips(current.provider).map(c => (
								<Text
									key={c.label}
									className={clsx("text-xxs", c.on ? "text" : "text-neutral-400 dark:text-neutral-500 line-through")}
								>
									{c.on ? "✓" : "✕"} {c.label}
								</Text>
							))}
						</View>
						{!!current.provider.reason && (
							<Text className="text-xxs text-amber-700 dark:text-amber-300">{current.provider.reason}</Text>
						)}
						<Text className="darker-text text-xxs">
							{current.provider.costNote ?? "Any usage cost is billed by the provider, not Bettercast."}
						</Text>
					</View>
				)}
			</View>
		</View>
	);
};
