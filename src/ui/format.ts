const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact relative time for dense rows: "now", "4m", "3h", "Yesterday", "5d", "12 Mar". */
export function relativeTime(ts: number, now: number): string {
	const delta = Math.max(0, now - ts);
	if (delta < MINUTE) return "now";
	if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
	if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
	if (delta < 2 * DAY) return "Yesterday";
	if (delta < 7 * DAY) return `${Math.floor(delta / DAY)}d`;
	const date = new Date(ts);
	const month = date.toLocaleString("en-GB", { month: "short" });
	const sameYear = date.getFullYear() === new Date(now).getFullYear();
	return sameYear
		? `${date.getDate()} ${month}`
		: `${date.getDate()} ${month} ${date.getFullYear()}`;
}

/** Absolute timestamp for detail panes. */
export function absoluteTime(ts: number): string {
	const date = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatBytes(bytes: number | undefined): string {
	if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** "in 12m" / "in 1h 5m" for pause-until countdowns. */
export function formatRemaining(until: number, now: number): string {
	const minutes = Math.max(0, Math.ceil((until - now) / MINUTE));
	if (minutes < 60) return `${minutes}m`;
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	return m ? `${h}h ${m}m` : `${h}h`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}
