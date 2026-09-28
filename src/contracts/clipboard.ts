// UI ↔ clipboard store contract. Types only; the store is the single source of truth.

export type ClipKind = "text" | "image" | "file" | "url";

export type ClipItem = {
	id: string;
	kind: ClipKind;
	/** Searchable/preview text: body for text/url, filename for image/file. */
	preview: string;
	/** true when `preview` is shorter than the stored payload; paste always uses the full payload. */
	previewTruncated?: boolean;
	/** Absolute path of the retained original (image payload or referenced file). */
	path?: string;
	/** Absolute path of a bounded thumbnail; never the only retained copy. */
	thumbnailPath?: string;
	byteSize?: number;
	/** Unix ms of the most recent copy occurrence. */
	copiedAt: number;
	sourceApp?: { name: string; bundleId?: string; evidence: "reported" | "inferred" };
	/** false when a referenced file no longer exists or is not readable. */
	available: boolean;
	pinned?: boolean;
};

export type ClipQuery = {
	text: string;
	kinds: ClipKind[]; // empty = all kinds
	/** Unix ms lower bound; undefined = no time filter. */
	since?: number;
};

export type ClipPage = {
	items: ClipItem[];
	hasMore: boolean;
	/** Total matches when cheaply known. */
	total?: number;
};

export type CaptureState =
	| { status: "capturing" }
	| { status: "paused"; until?: number } // until = Unix ms for pause-for-duration
	| { status: "private" } // private mode: new capture suspended
	| { status: "denied"; reason: string }
	| { status: "unavailable"; reason: string }
	| { status: "error"; message: string };

export type RetentionStatus = {
	retentionDays: number;
	capBytes: number;
	usedBytes: number;
	/** Days actually retained under the cap; < retentionDays means the cap is shortening history. */
	effectiveDays: number;
	itemCount: number;
};

export type ClipboardConfig = {
	retentionDays: number;
	capBytes: number;
	excludedBundleIds: string[];
	skipSensitive: boolean;
};

export type ClipAction =
	| "paste"
	| "pastePlain"
	| "copy"
	| "saveImage"
	| "reveal"
	| "delete"
	| "pin"
	| "unpin";

/** A dispatched paste is not proof of delivery; the UI never shows "verified". */
export type DeliveryResult =
	| { status: "dispatched" }
	| { status: "copied" }
	| { status: "done" } // non-paste actions (delete, pin, reveal, save)
	| { status: "focusChanged"; message: string }
	| { status: "failed"; message: string };

export type QueueStatus =
	| { status: "idle" }
	| { status: "running" }
	| { status: "paused" }
	| { status: "interrupted"; reason: string }
	| { status: "finished" };

export type QueueState = {
	/** Queued items in their original order (resolved snapshots, independent of the current page). */
	items: ClipItem[];
	/** Index of the next item paste-next will use. */
	position: number;
	reversed: boolean;
	state: QueueStatus;
	/** Last delivery outcome; surfaced as uncertain, not verified. */
	lastResult?: DeliveryResult;
};

/** Observable store surface the clipboard UI consumes (in addition to legacy clipboardItems/items). */
export interface ClipboardContract {
	query: ClipQuery;
	page: ClipPage;
	loading: boolean;
	loadError: string | null;
	capture: CaptureState;
	retention: RetentionStatus | null;
	config: ClipboardConfig;
	queue: QueueState;

	load(query: ClipQuery): Promise<void>;
	loadMore(): Promise<void>;
	act(id: string, action: ClipAction): Promise<DeliveryResult>;
	configure(partial: Partial<ClipboardConfig>): Promise<void>;
	pauseCapture(durationMs?: number): void;
	resumeCapture(): void;
	setPrivateMode(on: boolean): void;
	clearAll(): Promise<void>;

	queueStart(itemIds: string[]): void;
	queueNext(): Promise<DeliveryResult>;
	queueSkip(): void;
	queuePause(): void;
	queueResume(): void;
	queueReverse(): void;
	queueRestart(): void;
	queueCancel(): void;
}
