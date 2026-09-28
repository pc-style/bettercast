import { expect, test } from "bun:test";
import { assertAIPreflight, attachmentStatusForProvider } from "./ai-preflight";

const provider = {
	available: true,
	capabilities: {
		images: true,
		textFiles: true,
		pdf: false,
		tools: true,
		maxAttachmentBytes: 10,
	},
};
const attachment = {
	id: "a",
	name: "image",
	kind: "image",
	bytes: 6,
	status: "unsupported",
};
const input = {
	provider,
	attachments: [],
	contents: {},
	availableToolNames: ["web_search", "delete_file"],
	webSearch: false,
	toolsEnabled: false,
};

test("provider switch revalidates image but never promotes unsupported PDFs or extraction failures", () => {
	expect(
		attachmentStatusForProvider(attachment, { kind: "image" }, provider).status,
	).toBe("ready");
	expect(
		attachmentStatusForProvider(attachment, { kind: "pdf" }, provider).status,
	).toBe("unsupported");
	expect(
		attachmentStatusForProvider(
			attachment,
			{ kind: "image", unsupported: "bad format" },
			provider,
		).status,
	).toBe("unsupported");
	expect(
		attachmentStatusForProvider(attachment, undefined, provider).status,
	).toBe("extractFailed");
});
test("attachment budget is aggregate, includes both sides of boundary", () => {
	const second = { ...attachment, id: "b", bytes: 4 };
	const request = {
		...input,
		attachments: [attachment, second],
		contents: { a: { kind: "image" }, b: { kind: "image" } },
	};
	expect(() => assertAIPreflight(request)).not.toThrow();
	expect(() =>
		assertAIPreflight({
			...request,
			attachments: [attachment, { ...second, bytes: 5 }],
		}),
	).toThrow("Combined");
});
test("web-search requires a real enabled search tool and provider tool support", () => {
	expect(assertAIPreflight({ ...input, webSearch: true })).toEqual([
		"web_search",
	]);
	expect(assertAIPreflight({ ...input, toolsEnabled: true })).toEqual([
		"web_search",
		"delete_file",
	]);
	expect(() =>
		assertAIPreflight({
			...input,
			webSearch: true,
			availableToolNames: ["delete_file"],
		}),
	).toThrow("real search tool");
	expect(() =>
		assertAIPreflight({
			...input,
			webSearch: true,
			provider: {
				...provider,
				capabilities: { ...provider.capabilities, tools: false },
			},
		}),
	).toThrow("cannot call tools");
});
