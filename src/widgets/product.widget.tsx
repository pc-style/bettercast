import clsx from "clsx";
import { BackButton } from "components/BackButton";
import { EmptyState } from "components/EmptyState";
import { Notice } from "components/Notice";
import { observer } from "mobx-react-lite";
import { type FC, useEffect, useState } from "react";
import {
	ScrollView,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from "react-native";
import { useStore } from "store";
import { Widget } from "stores/ui.store";
import type { Quicklink } from "contracts/commands";
import { useNativeKeyCapture } from "ui/hooks";

const Button: FC<{
	label: string;
	onPress: () => void;
	disabled?: boolean;
	danger?: boolean;
}> = ({ label, onPress, disabled, danger }) => (
	<TouchableOpacity
		disabled={disabled}
		onPress={onPress}
		className={clsx(
			"rounded-md px-3 py-2 border border-color",
			danger ? "bg-red-500/10" : "subBg",
			disabled && "opacity-40",
		)}
	>
		<Text
			className={clsx("text-xs font-medium", danger ? "text-red-500" : "text")}
		>
			{label}
		</Text>
	</TouchableOpacity>
);
const Field: FC<{
	value: string;
	set: (s: string) => void;
	placeholder: string;
	multiline?: boolean;
	secure?: boolean;
}> = (p) => (
	<TextInput
		value={p.value}
		onChangeText={p.set}
		placeholder={p.placeholder}
		placeholderTextColor="#888"
		multiline={p.multiline}
		secureTextEntry={p.secure}
		className={clsx(
			"text text-sm rounded-md border border-color px-3 py-2",
			p.multiline && "h-24",
		)}
	/>
);
const Shell: FC<{ title: string; children: React.ReactNode }> = ({
	title,
	children,
}) => {
	const { ui } = useStore();
	return (
		<View className="flex-1">
			<View className="h-[48px] px-3 flex-row items-center gap-3 border-b border-color">
				<BackButton onPress={() => ui.focusWidget(Widget.SEARCH)} />
				<Text className="text text-base font-semibold">{title}</Text>
			</View>
			{children}
		</View>
	);
};

const ImportScreen = observer(() => {
	const { migration, ui } = useStore();
	const [raw, setRaw] = useState("");
	const apply = () =>
		ui.confirm("Apply selected import items?", () => migration.apply());
	return (
		<Shell title="Import preview">
			<ScrollView
				className="flex-1"
				contentContainerStyle={{ padding: 12, gap: 10 }}
			>
				<Notice
					tone="warning"
					title="Paste an export you chose"
					detail="Bettercast never reads Raycast files, private history, or product documents. Mappings are not supported yet; bindings remain disabled."
				/>
				<Field
					value={raw}
					set={setRaw}
					placeholder="Paste user-provided Raycast JSON…"
					multiline
				/>
				<View className="flex-row gap-2">
					<Button
						label="Preview only"
						disabled={!raw.trim()}
						onPress={() => migration.preview(raw)}
					/>
					{migration.current && (
						<Button
							label={migration.applying ? "Applying…" : "Apply selected"}
							disabled={
								migration.applying ||
								!migration.current.entries.some((e) => e.selected)
							}
							onPress={apply}
						/>
					)}
				</View>
				{migration.previewError && (
					<Notice
						tone="danger"
						title="Import operation failed"
						detail={migration.previewError}
					/>
				)}
				{migration.current &&
					(["import", "conflict", "unsupported", "skip"] as const).map(
						(outcome) => {
							const entries = migration.current!.entries.filter(
								(e) => e.outcome === outcome,
							);
							return entries.length ? (
								<View key={outcome} className="gap-1">
									<Text className="darker-text text-xxs font-semibold uppercase">
										{outcome} · {entries.length}
									</Text>
									{entries.map((e) => (
										<TouchableOpacity
											key={e.id}
											disabled={outcome !== "import"}
											onPress={() => migration.select(e.id, !e.selected)}
											className="p-2 rounded-md subBg flex-row gap-2"
										>
											<Text className="text w-4">{e.selected ? "✓" : "○"}</Text>
											<View className="flex-1">
												<Text className="text text-sm">{e.name}</Text>
												<Text className="darker-text text-xs">
													{e.kind}
													{e.detail ? ` · ${e.detail}` : ""}
													{e.reason ? ` · ${e.reason}` : ""}
												</Text>
											</View>
										</TouchableOpacity>
									))}
								</View>
							) : null;
						},
					)}
				{migration.report && (
					<View className="gap-2">
						<Notice
							tone="success"
							title={`Applied ${migration.report.imported}; skipped ${migration.report.skipped}`}
							detail={
								migration.report.failed.length
									? `${migration.report.failed.length} failed`
									: "No failures reported by storage."
							}
						/>
						{migration.report.canRollback && (
							<Button
								label="Rollback this import"
								danger
								onPress={() =>
									ui.confirm("Rollback this import?", () =>
										migration.rollback(),
									)
								}
							/>
						)}
					</View>
				)}
			</ScrollView>
		</Shell>
	);
});

const PrivacyScreen = observer(() => {
	const { clipboard: c, ui } = useStore();
	const [days, setDays] = useState(String(c.config.retentionDays));
	const [cap, setCap] = useState(
		String(Math.round(c.config.capBytes / 1048576)),
	);
	const [excluded, setExcluded] = useState(
		c.config.excludedBundleIds.join("\n"),
	);
	return (
		<Shell title="Privacy & retention">
			<ScrollView contentContainerStyle={{ padding: 12, gap: 10 }}>
				<Notice
					tone="warning"
					title="Encryption status is not verified here"
					detail="This screen cannot attest to runtime or disk encryption. Check macOS FileVault and your organization’s policy."
				/>
				<Text className="darker-text text-xs">Retention days</Text>
				<Field value={days} set={setDays} placeholder="30" />
				<Text className="darker-text text-xs">Storage cap (MB)</Text>
				<Field value={cap} set={setCap} placeholder="512" />
				<Text className="darker-text text-xs">
					Excluded app bundle IDs · one per line
				</Text>
				<Field
					value={excluded}
					set={setExcluded}
					placeholder="com.example.private"
					multiline
				/>
				<Button
					label="Save retention settings"
					onPress={() =>
						void c.configure({
							retentionDays: Number(days),
							capBytes: Number(cap) * 1048576,
							excludedBundleIds: excluded.split(/\s+/).filter(Boolean),
						})
					}
				/>
				<View className="flex-row gap-2">
					<Button label="Pause capture" onPress={() => c.pauseCapture()} />
					<Button label="Private mode" onPress={() => c.setPrivateMode(true)} />
					<Button
						label="Resume"
						onPress={() => {
							c.setPrivateMode(false);
							c.resumeCapture();
						}}
					/>
				</View>
				<Button
					danger
					label="Clear all clipboard history…"
					onPress={() =>
						ui.confirm("Permanently clear clipboard history?", () =>
							c.clearAll(),
						)
					}
				/>
				{c.loadError && (
					<Notice
						tone="danger"
						title="Clipboard operation failed"
						detail={c.loadError}
					/>
				)}
			</ScrollView>
		</Shell>
	);
});

const QuicklinksScreen = observer(() => {
	const { commands, product, ui } = useStore();
	const [edit, setEdit] = useState<Quicklink | null>(null);
	const [query, setQuery] = useState("");
	const draft = edit ?? {
		id: `quicklink-${Date.now()}`,
		name: "",
		url: "",
		alias: "",
	};
	return (
		<Shell title="Quicklinks">
			<ScrollView contentContainerStyle={{ padding: 12, gap: 8 }}>
				{product.error && (
					<Notice tone="danger" title="Save failed" detail={product.error} />
				)}
				{commands.quicklinks.map((l) => (
					<View
						key={l.id}
						className="subBg rounded-md p-2 flex-row items-center gap-2"
					>
						<View className="flex-1">
							<Text className="text text-sm">{l.name}</Text>
							<Text className="darker-text text-xs">{l.url}</Text>
						</View>
						{l.url.includes("{query}") && (
							<Field
								value={query}
								set={setQuery}
								placeholder="Query argument"
							/>
						)}
						<Button
							label="Open"
							onPress={() => commands.openQuicklink(l.id, query)}
						/>
						<Button label="Edit" onPress={() => setEdit({ ...l })} />
						<Button
							danger
							label="Delete"
							onPress={() =>
								ui.confirm(`Delete ${l.name}?`, () =>
									commands.removeQuicklink(l.id),
								)
							}
						/>
					</View>
				))}
				{!commands.quicklinks.length && !edit && (
					<EmptyState
						title="No quicklinks"
						detail="Add a URL. Use {query} where an encoded argument belongs."
					/>
				)}
				{edit ? (
					<View className="gap-2">
						<Field
							value={draft.name}
							set={(name) => setEdit({ ...draft, name })}
							placeholder="Name"
						/>
						<Field
							value={draft.url}
							set={(url) => setEdit({ ...draft, url })}
							placeholder="https://example.com/search?q={query}"
						/>
						<Field
							value={draft.alias ?? ""}
							set={(alias) => setEdit({ ...draft, alias })}
							placeholder="Alias (optional)"
						/>
						<View className="flex-row gap-2">
							<Button
								label="Save"
								onPress={() => {
									if (commands.saveQuicklink(draft)) setEdit(null);
								}}
							/>
							<Button label="Cancel" onPress={() => setEdit(null)} />
						</View>
					</View>
				) : (
					<Button label="Add quicklink" onPress={() => setEdit({ ...draft })} />
				)}
			</ScrollView>
		</Shell>
	);
});

const HotkeysScreen = observer(() => {
	const { commands } = useStore();
	const [filter, setFilter] = useState("");
	const [values, setValues] = useState<Record<string, string>>({});
	const [error, setError] = useState("");
	return (
		<Shell title="Aliases & shortcuts">
			<ScrollView contentContainerStyle={{ padding: 12, gap: 7 }}>
				<Notice
					title="Shortcuts are opt-in"
					detail="No defaults are assigned here and Bettercast never takes over a conflicting shortcut. Enter forms like command+shift+k."
				/>
				<Field value={filter} set={setFilter} placeholder="Filter commands" />
				{commands.commands
					.filter((c) =>
						`${c.title} ${c.alias ?? ""}`
							.toLowerCase()
							.includes(filter.toLowerCase()),
					)
					.map((c) => (
						<View
							key={c.id}
							className="subBg p-2 rounded-md flex-row gap-2 items-center"
						>
							<View className="flex-1">
								<Text className="text text-sm">{c.title}</Text>
								<Text className="darker-text text-xs">{c.kind}</Text>
							</View>
							<Field
								value={values[`a${c.id}`] ?? c.alias ?? ""}
								set={(v) => setValues((x) => ({ ...x, [`a${c.id}`]: v }))}
								placeholder="Alias"
							/>
							<Button
								label="Set alias"
								onPress={() =>
									commands.setAlias(c.id, values[`a${c.id}`] ?? c.alias ?? null)
								}
							/>
							<Field
								value={values[c.id] ?? c.hotkey ?? ""}
								set={(v) => setValues((x) => ({ ...x, [c.id]: v }))}
								placeholder="Shortcut"
							/>
							<Button
								label="Assign"
								onPress={() => {
									const r = commands.setHotkey(c.id, values[c.id] || null);
									setError(
										r.ok
											? ""
											: `${r.conflict.hotkey} conflicts with ${r.conflict.external ?? r.conflict.commandIds.join(", ")}. Existing assignment was kept.`,
									);
								}}
							/>
						</View>
					))}
				{error && (
					<Notice tone="danger" title="Shortcut not assigned" detail={error} />
				)}
			</ScrollView>
		</Shell>
	);
});

const ScriptScreen = observer(() => {
	const { commands } = useStore();
	const r = commands.activeRun;
	return (
		<Shell title="Script run">
			{!r ? (
				<EmptyState
					title="No script selected"
					detail="Choose a script command first."
				/>
			) : (
				<ScrollView contentContainerStyle={{ padding: 12, gap: 9 }}>
					<Notice
						tone="warning"
						title="Trusted local code"
						detail="This executable runs with your user permissions. Review every path and argument before continuing."
					/>
					<Text className="text text-xs font-mono">
						Executable: {r.runtime}
					</Text>
					<Text className="text text-xs font-mono">
						Arguments: {JSON.stringify(r.args)}
					</Text>
					<Text className="text text-xs font-mono">
						Working directory: {r.cwd}
					</Text>
					<Text className="darker-text text-xs">
						State: {r.state} · timeout {r.timeoutMs / 1000}s
					</Text>
					{r.state === "confirming" && (
						<Button
							label="I reviewed it — run"
							onPress={() => commands.confirmRun()}
						/>
					)}
					{(r.state === "running" || r.state === "confirming") && (
						<Button
							danger
							label="Cancel"
							onPress={() => commands.cancelRun()}
						/>
					)}
					<View className="bg-neutral-950 rounded-md p-3 min-h-[140px]">
						<Text selectable className="text-neutral-200 text-xs font-mono">
							{r.output || "Waiting for output…"}
							{r.error ? `\n${r.error}` : ""}
						</Text>
					</View>
				</ScrollView>
			)}
		</Shell>
	);
});

const MCP = observer(() => {
	const { mcp, ai } = useStore();
	const [mode, setMode] = useState<"provider" | "mcp">("provider");
	const [f, setF] = useState<Record<string, string>>({
		transport: "http",
		model: "",
	});
	const [error, setError] = useState("");
	useEffect(() => { void ai.initialize().catch(e => setError(String(e))); }, [ai]);
	const put = (k: string) => (v: string) => setF((x) => ({ ...x, [k]: v }));
	return (
		<Shell title="Providers & MCP approvals">
			<ScrollView contentContainerStyle={{ padding: 12, gap: 9 }}>
				<View className="flex-row gap-2">
					<Button
						label="Compatible provider"
						onPress={() => setMode("provider")}
					/>
					<Button label="Add MCP server" onPress={() => setMode("mcp")} />
					<Button
						danger
						label="Stop all tool jobs"
						onPress={() => mcp.stopAll()}
					/>
				</View>
				{error && (
					<Notice tone="danger" title="Configuration failed" detail={error} />
				)}
				{mode === "provider" ? (
					<View className="gap-2">
						<Notice
							title="Provider-compatible endpoint"
							detail="API keys are stored in Keychain. Enter the model identifier supported by your endpoint. Capabilities below are your declarations, not automatic compatibility checks."
						/>
						<Field
							value={f.label ?? ""}
							set={put("label")}
							placeholder="Provider label"
						/>
						<Field
							value={f.endpoint ?? ""}
							set={put("endpoint")}
							placeholder="https://endpoint.example/v1"
						/>
						<Field value={f.model} set={put("model")} placeholder="Model identifier" />
						<View className="flex-row gap-2">
							<Button label={`Images: ${f.images === "yes" ? "on" : "off"}`} onPress={() => put("images")(f.images === "yes" ? "no" : "yes")} />
							<Button label={`Tool calls: ${f.tools === "yes" ? "on" : "off"}`} onPress={() => put("tools")(f.tools === "yes" ? "no" : "yes")} />
						</View>
						<Field
							secure
							value={f.key ?? ""}
							set={put("key")}
							placeholder="API key (optional, write-only)"
						/>
						<Button
							disabled={!ai.configureProvider}
							label="Save provider"
							onPress={() =>
								void ai
									.configureProvider?.({
										id: "compatible",
										label: f.label,
										endpoint: f.endpoint,
										modelId: f.model,
										images: f.images === "yes",
										tools: f.tools === "yes",
										apiKey: f.key || undefined,
									})
									.then(() => { put("key")(""); setError(""); })
									.catch((e) => setError(String(e)))
							}
						/>
					</View>
				) : (
					<View className="gap-2">
						<Notice
							tone="warning"
							title="Saved disabled"
							detail="Adding a server does not contact or execute it. Explicitly enable it below; every discovered tool starts off disabled."
						/>
						<Field value={f.id ?? ""} set={put("id")} placeholder="Server ID" />
						<Field value={f.name ?? ""} set={put("name")} placeholder="Name" />
						<View className="flex-row gap-2">
							<Button
								label={`Transport: ${f.transport}`}
								onPress={() =>
									put("transport")(f.transport === "http" ? "stdio" : "http")
								}
							/>
						</View>
						<Field
							value={f.target ?? ""}
							set={put("target")}
							placeholder={
								f.transport === "http"
									? "HTTPS URL"
									: "Absolute executable path"
							}
						/>
						<Field
							value={f.args ?? ""}
							set={put("args")}
							placeholder="Arguments, one per line"
							multiline
						/>
						<Field
							secure
							value={f.key ?? ""}
							set={put("key")}
							placeholder="API key (optional, write-only)"
						/>
						<Button
							disabled={!mcp.addServer}
							label="Save disabled server"
							onPress={() =>
								void mcp
									.addServer?.({
										id: f.id,
										name: f.name,
										transport: f.transport as "http" | "stdio",
										target: f.target,
										args: f.args?.split("\n").filter(Boolean),
										apiKey: f.key || undefined,
									})
									.catch((e) => setError(String(e)))
							}
						/>
					</View>
				)}
				{mcp.servers.map((s) => (
					<View key={s.id} className="subBg rounded-md p-3 gap-2">
						<View className="flex-row items-center">
							<View className="flex-1">
								<Text className="text font-medium">{s.name}</Text>
								<Text className="darker-text text-xs">
									{s.transport} · {s.target} · {s.status}
								</Text>
							</View>
							<Button
								label={s.enabled ? "Disable" : "Enable explicitly"}
								onPress={() => void mcp.setServerEnabled(s.id, !s.enabled)}
							/>
						</View>
						{s.error && (
							<Notice tone="danger" title="Server error" detail={s.error} />
						)}
						{s.tools.map((t) => (
							<View key={t.name} className="flex-row items-center">
								<Text className="text text-xs flex-1">
									{t.name} · {t.sideEffects.join(", ")}
								</Text>
								<Button
									label={t.enabled ? "Opt out" : "Opt in"}
									onPress={() => mcp.setToolEnabled(s.id, t.name, !t.enabled)}
								/>
							</View>
						))}
					</View>
				))}
			</ScrollView>
		</Shell>
	);
});

export const ProductWidget: FC<{ widget: Widget }> = observer(({ widget }) => {
	useNativeKeyCapture({ enter: false, vertical: false });
	if (widget === Widget.IMPORT_PREVIEW) return <ImportScreen />;
	if (widget === Widget.PRIVACY) return <PrivacyScreen />;
	if (widget === Widget.QUICKLINKS) return <QuicklinksScreen />;
	if (widget === Widget.HOTKEYS) return <HotkeysScreen />;
	if (widget === Widget.SCRIPT_RUN) return <ScriptScreen />;
	return <MCP />;
});
