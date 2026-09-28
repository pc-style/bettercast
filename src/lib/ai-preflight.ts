import type { Attachment, ProviderInfo } from "../contracts/ai";

export type PreflightAttachmentContent = {
	kind: "image" | "text" | "pdf" | "other";
	unsupported?: string;
};

export function attachmentStatusForProvider(
	attachment: Attachment,
	content: PreflightAttachmentContent | undefined,
	provider: ProviderInfo | undefined,
): Pick<Attachment, "status" | "note"> {
	if (!content)
		return {
			status: "extractFailed",
			note: "Attachment content is unavailable.",
		};
	if (content.unsupported)
		return { status: "unsupported", note: content.unsupported };
	if (
		attachment.bytes > (provider?.capabilities.maxAttachmentBytes ?? 8_388_608)
	)
		return {
			status: "tooLarge",
			note: "Attachment exceeds this provider's size limit.",
		};
	const supported =
		content.kind === "image"
			? provider?.capabilities.images
			: content.kind === "text"
				? provider?.capabilities.textFiles
				: content.kind === "pdf"
					? provider?.capabilities.pdf
					: false;
	if (!supported)
		return {
			status: "unsupported",
			note: `Choose a provider that supports ${content.kind} attachments.`,
		};
	return { status: "ready", note: undefined };
}

export function assertAIPreflight(input: {
	provider: ProviderInfo | undefined;
	attachments: Attachment[];
	contents: Record<string, PreflightAttachmentContent>;
	webSearch: boolean;
	toolsEnabled: boolean;
	availableToolNames: string[];
}) {
	if (!input.provider?.available)
		throw new Error("Configure an available provider first");
	const selectedTools = input.webSearch
		? input.availableToolNames.filter((name) => /search/i.test(name))
		: input.toolsEnabled
			? input.availableToolNames
			: [];
	if (input.webSearch && !selectedTools.length)
		throw new Error(
			"Enable a real search tool in AI Tools & Approvals first; no search has been performed.",
		);
	if (selectedTools.length && !input.provider.capabilities.tools)
		throw new Error("This provider cannot call tools");
	if (
		input.attachments.reduce((sum, item) => sum + item.bytes, 0) >
		(input.provider.capabilities.maxAttachmentBytes ?? 8_388_608)
	)
		throw new Error("Combined attachments exceed this provider's size limit");
	for (const attachment of input.attachments) {
		const status = attachmentStatusForProvider(
			attachment,
			input.contents[attachment.id],
			input.provider,
		);
		if (status.status !== "ready")
			throw new Error(
				`${attachment.name}: ${status.note ?? "unsupported by this provider or not ready"}`,
			);
	}
	return selectedTools;
}
