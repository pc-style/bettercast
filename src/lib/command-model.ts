export function canonicalHotkey(value: string): string {
	const aliases: Record<string, string> = {
		cmd: "command",
		ctrl: "control",
		alt: "option",
		"⌘": "command",
		"⌥": "option",
		"⇧": "shift",
		"⌃": "control",
		enter: "return",
	};
	const tokens = value
		.toLowerCase()
		.split("+")
		.map((x) => aliases[x.trim()] ?? x.trim());
	const modifiers = ["command", "control", "option", "shift"];
	const keys = tokens.filter((x) => !modifiers.includes(x));
	if (
		keys.length !== 1 ||
		!/^([a-z0-9]|space|return|up|down|left|right)$/.test(keys[0]) ||
		!tokens.some((x) => modifiers.includes(x)) ||
		new Set(tokens).size !== tokens.length
	)
		throw new Error(
			"Use modifiers and one supported key, for example command+shift+k",
		);
	return [...modifiers.filter((x) => tokens.includes(x)), keys[0]].join("+");
}
export function quicklinkURL(template: string, query: string): string {
	if (/\{(?!query\})/.test(template))
		throw new Error("Only {query} placeholders are supported");
	const value = template.replace(/\{query\}/g, encodeURIComponent(query));
	const url: any = new URL(value);
	if (
		!["http:", "https:", "mailto:"].includes(url.protocol) ||
		url.username ||
		url.password
	)
		throw new Error(
			"Quicklink must be an HTTP(S) or mailto URL without credentials",
		);
	return value;
}
export type ExtensionManifest = {
	version: 1;
	id: string;
	title: string;
	runtime: string;
	entry: string;
	enabled: boolean;
	arguments?: string[];
};
export function parseExtension(raw: string): ExtensionManifest {
	if (raw.length > 32_768) throw new Error("Manifest too large");
	const value = JSON.parse(raw);
	if (
		value.version !== 1 ||
		!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.id) ||
		typeof value.title !== "string" ||
		!value.title.trim() ||
		typeof value.runtime !== "string" ||
		!value.runtime.startsWith("/") ||
		typeof value.entry !== "string" ||
		value.entry.startsWith("/") ||
		value.entry.split("/").includes("..") ||
		!value.entry.endsWith(".ts") ||
		(value.enabled !== true && value.enabled !== false)
	)
		throw new Error("Invalid TypeScript extension manifest");
	if (
		value.arguments !== undefined &&
		(!Array.isArray(value.arguments) ||
			value.arguments.length > 32 ||
			!value.arguments.every((x: unknown) => typeof x === "string"))
	)
		throw new Error("Invalid extension arguments");
	return value;
}
