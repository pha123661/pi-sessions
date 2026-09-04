// @ts-nocheck
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	fuzzyFilter,
	getKeybindings,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";


export type UnifiedSessionInfo = {
	id: string;
	name: string;
	cwd: string;
	state: "needs_input" | "working" | "completed";
	status?: string;
	pid?: number | null;
	lastActivityAt?: number;
	agentStatus?: string;
	transcript?: string;
	shortName?: string;
	branch?: string;
	summary?: string;
	modified?: Date;
	isLive?: boolean;
	isCurrent?: boolean;
	sessionFile?: string;
	pinned?: boolean;
	index?: number;
};

type SessionInfo = UnifiedSessionInfo;


type SavedSessionInfo = {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	modified?: Date;
	firstMessage?: string;
	messageCount?: number;
};

type SessionsActions = {
	getSessions: (scope: "current" | "all") => Promise<UnifiedSessionInfo[]>;
	getResumeSessions?: () => Promise<SavedSessionInfo[]>;
	getAttached: () => string | null;
	getCwd: () => string;
	getDefaultScope?: () => "current" | "all";
	switchTo: (id: string) => Promise<void>;
	dispatchSession?: (prompt: string, cwd?: string) => Promise<string>;
	resumeSession: (sessionPath?: string) => Promise<string | void>;
	renameSession?: (idOrPath: string, newName: string) => Promise<void>;
	togglePinSession?: (idOrPath: string) => void;
	killSession: (id: string) => Promise<void>;
	notify: (message: string, type?: "info" | "warning" | "error") => void;
};

type WidgetSnapshot = {
	attached: string | null;
	sessions: SessionInfo[];
	updatedAt: number;
};

const PARENT_SESSION_ID = "__parent__";
const DEFAULT_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_SPINNER_INTERVAL_MS = 80;

type WorkingIndicatorOptions = {
	frames?: string[];
	intervalMs?: number;
};

function isCtrl(data: string, key: "o" | "r" | "k" | "p" | "n" | "s" | "t" | "x" | "j" | "c"): boolean {
	const codes: Record<string, string> = {
		o: "\x0f",
		r: "\x12",
		k: "\x0b",
		p: "\x10",
		n: "\x0e",
		s: "\x13",
		t: "\x14",
		x: "\x18",
		j: "\x0a",
		c: "\x03",
	};
	return data === codes[key] || matchesKey(data, Key.ctrl(key));
}

function isAltDigit(data: string): number | null {
	if (data.length === 2 && data[0] === "\x1b" && data[1] >= "1" && data[1] <= "9") {
		return parseInt(data[1], 10);
	}
	return null;
}

function formatRelativeTime(date?: Date): string {
	if (!date) return "now";
	const diffMs = Date.now() - date.getTime();
	if (diffMs < 0 || !Number.isFinite(diffMs)) return "now";
	const sec = Math.floor(diffMs / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	const hour = Math.floor(min / 60);
	if (hour < 24) return `${hour}h`;
	const day = Math.floor(hour / 24);
	if (day < 30) return `${day}d`;
	const mo = Math.floor(day / 30);
	if (mo < 12) return `${mo}mo`;
	return `${Math.floor(day / 365)}y`;
}

function padVisible(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "…");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function renderInputChild(input: Input, width: number): string {
	const line = input.render(Math.max(1, width))[0] ?? "";
	return line.startsWith("> ") ? line.slice(2) : line;
}

function cwdBasename(cwd: string): string {
	const trimmed = cwd.replace(/\/+$/, "");
	const i = trimmed.lastIndexOf("/");
	return i >= 0 ? trimmed.slice(i + 1) || "/" : trimmed || "/";
}

function computeShortNames(sessions: SessionInfo[]): void {
	const counts = new Map<string, number>();
	for (const session of sessions) {
		const base = cwdBasename(session.cwd || "") || session.name;
		const n = counts.get(base) ?? 0;
		counts.set(base, n + 1);
		session.shortName = n === 0 ? base : `${base}<${n}>`;
	}
}

export class SessionWidget implements Component {
	private frame = 0;
	private timer: NodeJS.Timeout | null = null;
	private timerIntervalMs = DEFAULT_SPINNER_INTERVAL_MS;

	constructor(
		private readonly theme: Theme,
		private readonly getSnapshot: () => WidgetSnapshot | null,
		private readonly requestRender: () => void,
		private readonly getWorkingIndicator?: () => WorkingIndicatorOptions | undefined,
	) {}

	render(width: number): string[] {
		const snapshot = this.getSnapshot();
		if (!snapshot || snapshot.sessions.length === 0) {
			this.updateTimer(false);
			return [];
		}
		const sessions = [...snapshot.sessions];
		computeShortNames(sessions);
		const ordered = this.currentLast(sessions, snapshot.attached);
		const hasWorking = ordered.some((session) => this.isWorking(session));
		this.updateTimer(hasWorking);
		const segments = ordered.map((session) =>
			this.segment(session, snapshot.attached),
		);
		const line = this.fitFromRight(segments, width);
		if (!line) return [];
		return [" ".repeat(Math.max(0, width - visibleWidth(line))) + line];
	}

	invalidate(): void {}

	dispose(): void {
		this.updateTimer(false);
	}

	private currentLast(
		sessions: SessionInfo[],
		attached: string | null,
	): SessionInfo[] {
		if (!attached) return sessions;
		const current = sessions.find(
			(session) => session.id === attached || session.name === attached,
		);
		if (!current) return sessions;
		return sessions.filter((session) => session !== current).concat(current);
	}

	private isWorking(session: SessionInfo): boolean {
		return (session.agentStatus || "idle") === "working";
	}

	private spinnerFrame(): string {
		const indicator = this.getWorkingIndicator?.();
		const frames =
			indicator?.frames !== undefined
				? [...indicator.frames]
				: DEFAULT_SPINNER_FRAMES;
		if (!frames.length) return "";
		const frame = frames[this.frame % frames.length] ?? "";
		return indicator !== undefined ? frame : this.theme.fg("accent", frame);
	}

	private spinnerIntervalMs(): number {
		const interval = this.getWorkingIndicator?.()?.intervalMs;
		return interval && interval > 0 ? interval : DEFAULT_SPINNER_INTERVAL_MS;
	}

	private isWaiting(session: SessionInfo): boolean {
		return (session.agentStatus || "idle") === "waiting";
	}

	private segment(session: SessionInfo, attached: string | null): string {
		const current = session.id === attached || session.name === attached;
		const name = this.theme.fg(
			current ? "accent" : "muted",
			truncateToWidth(session.shortName || session.name, 18, "…"),
		);
		if (this.isWorking(session)) {
			const spinner = this.spinnerFrame();
			return spinner ? `${spinner} ${name}` : name;
		}
		if (this.isWaiting(session)) {
			return `${this.theme.fg("warning", "?")} ${name}`;
		}
		return `${this.theme.fg("success", "✓")} ${name}`;
	}

	private fitFromRight(segments: string[], width: number): string {
		let line = "";
		for (let i = segments.length - 1; i >= 0; i--) {
			const next = line ? `${segments[i]}  ${line}` : segments[i]!;
			if (visibleWidth(next) > width) break;
			line = next;
		}
		return line;
	}

	private updateTimer(shouldRun: boolean): void {
		const interval = this.spinnerIntervalMs();
		if (shouldRun && this.timer && this.timerIntervalMs !== interval) {
			clearInterval(this.timer);
			this.timer = null;
		}
		if (shouldRun && !this.timer) {
			this.timerIntervalMs = interval;
			this.timer = setInterval(() => {
				this.frame++;
				this.requestRender();
			}, interval);
			return;
		}
		if (!shouldRun && this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}
}

// --- FileExplorer (from pi-project) ---

const FILE_EXPLORER_MAX_VISIBLE = 8;
const SESSIONS_MAX_VISIBLE = 12;
const RESUME_MAX_VISIBLE = 12;

function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return path.join(homedir(), input.slice(2));
	return input;
}

function normalizeExistingDir(input: string): string | null {
	try {
		const expanded = expandHome(input.trim());
		if (!expanded) return null;
		const absolute = path.resolve(expanded);
		if (!existsSync(absolute)) return null;
		if (!statSync(absolute).isDirectory()) return null;
		return absolute;
	} catch {
		return null;
	}
}

function relativeTime(date: Date): string {
	const ms = Date.now() - date.getTime();
	if (!Number.isFinite(ms) || ms < 0) return "now";
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return "now";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hour = Math.floor(min / 60);
	if (hour < 24) return `${hour}h ago`;
	const day = Math.floor(hour / 24);
	if (day < 30) return `${day}d ago`;
	const month = Math.floor(day / 30);
	if (month < 12) return `${month}mo ago`;
	return `${Math.floor(month / 12)}y ago`;
}

function fits(width: number, text: string): string {
	return truncateToWidth(text, Math.max(0, width), "…");
}

function indent(width: number, text: string): string {
	return fits(width, `  ${text}`);
}

function setInputValueAtEnd(input: Input, value: string): void {
	input.setValue(value);
	(input as unknown as { cursor: number }).cursor = value.length;
}

function dirPrefix(value: string): string {
	const slash = value.lastIndexOf("/");
	return slash >= 0 ? value.slice(0, slash + 1) : "";
}

function formatSize(bytes: number): string {
	if (bytes < 1000) return `${bytes}b`;
	if (bytes < 1_000_000)
		return `${(bytes / 1000).toFixed(bytes < 10_000 ? 1 : 0)}kb`;
	if (bytes < 1_000_000_000)
		return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)}Mb`;
	return `${(bytes / 1_000_000_000).toFixed(1)}Gb`;
}

type FileEntry = {
	name: string;
	path: string;
	isDirectory: boolean;
	size: string;
	modified: Date;
};

function readFileEntries(dir: string): FileEntry[] {
	const entries: FileEntry[] = [
		{
			name: "./",
			path: dir,
			isDirectory: true,
			size: "",
			modified: new Date(),
		},
	];

	for (const dirent of readdirSync(dir, { withFileTypes: true })) {
		try {
			const entryPath = path.join(dir, dirent.name);
			const stat = statSync(entryPath);
			const isDirectory = stat.isDirectory();
			entries.push({
				name: `${dirent.name}${isDirectory ? "/" : ""}`,
				path: entryPath,
				isDirectory,
				size: isDirectory ? "" : formatSize(stat.size),
				modified: stat.mtime,
			});
		} catch {
			// Ignore unreadable entries.
		}
	}

	return entries.sort((a, b) => {
		if (a.name === "./") return -1;
		if (b.name === "./") return 1;
		if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
}

export class FileExplorer implements Component, Focusable {
	private entries: FileEntry[] = [];
	private selectedIndex = 0;
	private readonly searchInput = new Input();
	private error: string | undefined;
	private readonly theme: Theme;
	private readonly done: (path: string | null) => void;
	private readonly requestRender: () => void;

	constructor(
		initialCwd: string,
		theme: Theme,
		done: (path: string | null) => void,
		requestRender: () => void,
	) {
		setInputValueAtEnd(
			this.searchInput,
			`${normalizeExistingDir(initialCwd) ?? homedir()}/`,
		);
		this.theme = theme;
		this.done = done;
		this.requestRender = requestRender;
		this.refresh();
	}

	render(width: number): string[] {
		const dim = (s: string) => this.theme.fg("dim", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const lines: string[] = [];
		lines.push(this.border(width));
		lines.push(this.header(width));
		lines.push(this.border(width, "dim"));
		this.renderEntries(lines, width);
		lines.push(this.border(width));
		lines.push(
			fits(
				width,
				dim("↑↓/<C-p>/<C-n>") +
					muted(" move · ") +
					dim("<tab>") +
					muted(" enter folder · ") +
					dim("<enter>") +
					muted(" choose folder · ") +
					dim("<M-backspace>") +
					muted(" parent · ") +
					dim("<esc>") +
					muted(" cancel"),
			),
		);
		return lines;
	}

	get focused(): boolean {
		return this.searchInput.focused;
	}

	set focused(value: boolean) {
		this.searchInput.focused = value;
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) {
			this.move(1);
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.enterSelectedDirectory();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.chooseSelectedDirectory();
			return;
		}
		if (getKeybindings().matches(data, "tui.editor.deleteWordBackward")) {
			this.deletePathSegmentBackward();
			return;
		}

		const before = this.search;
		const beforeDir = dirPrefix(before);
		this.searchInput.handleInput(data);
		const after = this.search;
		if (after !== before) {
			if (dirPrefix(after) !== beforeDir) this.refresh();
			else this.clampSelection();
		}
		this.requestRender();
	}

	private get search(): string {
		return this.searchInput.getValue();
	}

	private set search(value: string) {
		setInputValueAtEnd(this.searchInput, value);
	}

	private deletePathSegmentBackward(): void {
		const before = this.search;
		const trimmed = before.replace(/\/+$/, "");
		const slash = trimmed.lastIndexOf("/");
		if (slash < 0) return;
		const next = trimmed.slice(0, slash + 1);
		if (next === before) return;
		this.search = next || "/";
		this.refresh();
		this.requestRender();
	}

	private refresh(): void {
		try {
			this.entries = readFileEntries(dirPrefix(this.search));
			this.selectedIndex = Math.max(
				0,
				Math.min(this.selectedIndex, Math.max(0, this.entries.length - 1)),
			);
			this.error = undefined;
			this.selectedIndex = Math.min(1, Math.max(0, this.entries.length - 1));
		} catch (error) {
			this.entries = [];
			this.selectedIndex = 0;
			this.error = error instanceof Error ? error.message : String(error);
		}
	}

	private header(width: number): string {
		const entries = this.filteredEntries();
		const total = Math.max(1, entries.length);
		const index = Math.min(this.selectedIndex + 1, total);
		const prefix = `${index}/${total}\tOpen session in folder: `;
		const input = renderInputChild(
			this.searchInput,
			Math.max(1, width - visibleWidth(prefix)),
		);
		return this.theme.fg("accent", fits(width, `${prefix}${input}`));
	}

	private border(width: number, color: "accent" | "dim" = "accent"): string {
		return this.theme.fg(color, "─".repeat(Math.max(0, width)));
	}

	private renderEntries(lines: string[], width: number): void {
		if (this.error) {
			lines.push(this.theme.fg("dim", indent(width, this.error)));
			this.padRows(lines, width, 1);
			return;
		}
		const entries = this.filteredEntries();
		if (entries.length === 0) {
			lines.push(
				this.theme.fg(
					"dim",
					indent(width, this.search ? "No matches." : "No entries."),
				),
			);
			this.padRows(lines, width, 1);
			return;
		}

		let rendered = 0;
		const start = this.visibleStart(entries.length);
		const end = Math.min(entries.length, start + FILE_EXPLORER_MAX_VISIBLE);
		for (let i = start; i < end; i++) {
			lines.push(
				this.entryLine(width, entries[i]!, {
					selected: i === this.selectedIndex,
				}),
			);
			rendered++;
		}
		this.padRows(lines, width, rendered);
	}

	private entryLine(
		width: number,
		entry: FileEntry,
		options: { selected: boolean },
	): string {
		if (entry.name === "./") return this.currentDirLine(width, options);
		const left = `${options.selected ? "›" : " "} ${entry.name}`;
		const timeW = 7;
		const meta = `${entry.size.padStart(5)}  ${relativeTime(entry.modified).padStart(timeW)}`;
		const metaWidth = Math.min(
			5 + 2 + timeW,
			Math.max(0, Math.floor(width * 0.38)),
		);
		const renderedMeta = fits(metaWidth, meta);
		const renderedLeft = fits(
			Math.max(0, width - visibleWidth(renderedMeta) - 1),
			left,
		);
		const gap = " ".repeat(
			Math.max(
				1,
				width - visibleWidth(renderedLeft) - visibleWidth(renderedMeta),
			),
		);
		const styledLeft = !entry.isDirectory
			? this.theme.fg("dim", renderedLeft)
			: options.selected
				? this.theme.fg("accent", renderedLeft)
				: renderedLeft;
		return `${styledLeft}${gap}${this.theme.fg("dim", renderedMeta)}`;
	}

	private currentDirLine(
		width: number,
		options: { selected: boolean },
	): string {
		const marker = options.selected ? "›" : " ";
		const name = `${marker} ./`;
		const note = " (select current dir)";
		const availableNoteWidth = Math.max(0, width - visibleWidth(name));
		const renderedNote = fits(availableNoteWidth, note);
		const renderedName = fits(
			Math.max(0, width - visibleWidth(renderedNote)),
			name,
		);
		const padding = " ".repeat(
			Math.max(
				0,
				width - visibleWidth(renderedName) - visibleWidth(renderedNote),
			),
		);
		const styledName = options.selected
			? this.theme.fg("accent", renderedName)
			: renderedName;
		return `${styledName}${this.theme.fg("dim", renderedNote)}${padding}`;
	}

	private visibleStart(total: number): number {
		if (total <= FILE_EXPLORER_MAX_VISIBLE) return 0;
		const half = Math.floor(FILE_EXPLORER_MAX_VISIBLE / 2);
		return Math.min(
			Math.max(0, this.selectedIndex - half),
			total - FILE_EXPLORER_MAX_VISIBLE,
		);
	}

	private padRows(lines: string[], width: number, rendered: number): void {
		for (let i = rendered; i < FILE_EXPLORER_MAX_VISIBLE; i++) {
			lines.push(" ".repeat(Math.max(0, width)));
		}
	}

	private filteredEntries(): FileEntry[] {
		const query = this.search.trim().split("/").pop() ?? "";
		if (!query) return this.entries;
		return fuzzyFilter(this.entries, query, (entry) => entry.name);
	}

	private clampSelection(): void {
		const maxIndex = Math.max(0, this.filteredEntries().length - 1);
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, maxIndex));
	}

	private move(delta: number): void {
		const entries = this.filteredEntries();
		if (entries.length === 0) return;
		this.selectedIndex =
			(this.selectedIndex + delta + entries.length) % entries.length;
		this.requestRender();
	}

	private selected(): FileEntry | undefined {
		return this.filteredEntries()[this.selectedIndex];
	}

	private enterSelectedDirectory(): void {
		const entry = this.selected();
		if (!entry?.isDirectory) return;
		const next = normalizeExistingDir(entry.path) + "/";
		if (!next) return;
		this.search = next;
		this.refresh();
		this.requestRender();
	}

	private chooseSelectedDirectory(): void {
		const entry = this.selected();
		if (!entry?.isDirectory) return;
		const chosen = normalizeExistingDir(entry.path);
		if (chosen) this.done(chosen);
	}
}

class ResumeSessionPicker implements Component, Focusable {
	private sessions: SavedSessionInfo[] = [];
	private selected = 0;
	private loading = true;
	private error: string | null = null;
	private readonly filterInput = new Input();

	constructor(
		private readonly theme: any,
		private readonly loadSessions: () => Promise<SavedSessionInfo[]>,
		private readonly onDone: (sessionPath: string | null) => void,
		private readonly requestRender: () => void,
	) {
		this.filterInput.focused = true;
		void this.refresh();
	}

	get focused(): boolean {
		return true;
	}

	set focused(_value: boolean) {}

	private async refresh(): Promise<void> {
		try {
			this.error = null;
			this.sessions = await this.loadSessions();
		} catch (error) {
			this.error = String(error);
		} finally {
			this.loading = false;
			this.clampSelection();
			this.requestRender();
		}
	}

	private filteredSessions(): SavedSessionInfo[] {
		const query = this.filterInput.getValue().trim();
		return fuzzyFilter(this.sessions, query, (session) =>
			[
				session.name,
				session.cwd,
				session.firstMessage,
				session.path,
				session.id,
			]
				.filter(Boolean)
				.join(" "),
		);
	}

	private visibleStart(total: number): number {
		if (total <= RESUME_MAX_VISIBLE) return 0;
		const half = Math.floor(RESUME_MAX_VISIBLE / 2);
		return Math.min(
			Math.max(0, this.selected - half),
			total - RESUME_MAX_VISIBLE,
		);
	}

	private padRows(
		lines: string[],
		width: number,
		rendered: number,
		totalItems: number,
	): void {
		const target = Math.min(Math.max(totalItems, rendered), RESUME_MAX_VISIBLE);
		for (let i = rendered; i < target; i++) {
			lines.push(" ".repeat(Math.max(0, width)));
		}
	}

	private clampSelection(): void {
		const max = Math.max(0, this.filteredSessions().length - 1);
		this.selected = Math.max(0, Math.min(this.selected, max));
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.onDone(null);
			return;
		}
		if (matchesKey(data, "up") || isCtrl(data, "p")) {
			this.selected = Math.max(0, this.selected - 1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "down") || isCtrl(data, "n")) {
			this.selected = Math.min(
				Math.max(0, this.filteredSessions().length - 1),
				this.selected + 1,
			);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			const session = this.filteredSessions()[this.selected];
			if (session?.path) this.onDone(session.path);
			return;
		}
		const before = this.filterInput.getValue();
		this.filterInput.handleInput(data);
		if (this.filterInput.getValue() !== before) this.selected = 0;
		this.clampSelection();
		this.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		const border = (color: "accent" | "dim" = "accent") =>
			th.fg(color, "─".repeat(Math.max(0, width)));
		const accent = (s: string) => th.fg("accent", s);
		const dim = (s: string) => th.fg("dim", s);
		const muted = (s: string) => th.fg("muted", s);
		const error = (s: string) => th.fg("error", s);
		const lines: string[] = [];
		const visibleSessions = this.filteredSessions();
		const total = Math.max(1, visibleSessions.length);
		const index = Math.min(this.selected + 1, total);
		const prefix = `${index}/${total}\tResume: `;
		const renderedInput = renderInputChild(
			this.filterInput,
			width - visibleWidth(prefix),
		);

		lines.push(border());
		lines.push(accent(fits(width, `${prefix}${renderedInput}`)));
		lines.push(border("dim"));
		const startIdx = this.visibleStart(visibleSessions.length);
		const endIdx = Math.min(
			visibleSessions.length,
			startIdx + RESUME_MAX_VISIBLE,
		);
		let rendered = 0;
		if (this.error) {
			lines.push(padVisible(`  ${error("error")} ${this.error}`, width));
			rendered = 1;
		} else if (visibleSessions.length === 0) {
			lines.push(
				padVisible(
					`  ${dim(this.loading ? "Loading…" : "No saved sessions")}`,
					width,
				),
			);
			rendered = 1;
		} else {
			for (let i = startIdx; i < endIdx; i++) {
				const session = visibleSessions[i]!;
				const marker = i === this.selected ? "›" : " ";
				const title =
					session.name || session.firstMessage || session.id.slice(0, 8);
				const styledName =
					i === this.selected
						? accent(`${marker} ${title}`)
						: `${marker} ${title}`;

				const cwdText = session.cwd || "";
				const msgCountText = session.messageCount
					? String(session.messageCount)
					: "";
				const timeText = session.modified ? relativeTime(session.modified) : "";

				const rightParts = [];
				if (cwdText) rightParts.push(muted(cwdText));
				if (msgCountText && timeText)
					rightParts.push(dim(`${msgCountText} ${timeText}`));
				else if (msgCountText) rightParts.push(dim(msgCountText));
				else if (timeText) rightParts.push(dim(timeText));
				const rightText = rightParts.join("  ");
				const rightWidth = visibleWidth(rightText);

				const leftWidth = Math.max(10, width - rightWidth - 1);
				const left = truncateToWidth(styledName, leftWidth, "…");
				const gap = " ".repeat(
					Math.max(1, width - visibleWidth(left) - rightWidth),
				);
				let line = left + gap + rightText;
				if (i === this.selected) {
					line = th.bg("selectedBg", line);
				}
				lines.push(line);
				rendered++;
			}
		}
		this.padRows(lines, width, rendered, this.sessions.length);
		lines.push(border());
		lines.push(
			padVisible(
				dim("↑↓/<C-p>/<C-n>") +
					muted(" move · ") +
					dim("<enter>") +
					muted(" resume · ") +
					dim("<esc>") +
					muted(" back"),
				width,
			),
		);
		return lines;
	}

	invalidate(): void {
		this.filterInput.invalidate();
	}

	dispose(): void {}
}

class SessionsView {
	private sessions: UnifiedSessionInfo[] = [];
	private displayList: UnifiedSessionInfo[] = [];
	private selected = 0;
	private scope: "current" | "all" = "current";
	private loading = true;
	private error: string | null = null;
	private closed = false;
	private readonly taskInput = new Input();
	private renameMode = false;
	private readonly renameInput = new Input();
	private showPeek = false;
	private showHelp = false;
	private lastCtrlCTime = 0;
	private readonly theme: any;
	private readonly done: () => void;
	private readonly actions: SessionsActions;
	private readonly requestRender: () => void;
	private timer: NodeJS.Timeout | null = null;

	constructor(
		theme: any,
		done: () => void,
		actions: SessionsActions,
		requestRender: () => void,
	) {
		this.theme = theme;
		this.done = done;
		this.actions = actions;
		this.requestRender = requestRender;
		this.scope = actions.getDefaultScope?.() || "current";
		this.taskInput.focused = true;
		void this.refresh();
		this.timer = setInterval(() => void this.refresh(), 1200);
	}

	get focused(): boolean {
		return true;
	}

	set focused(_value: boolean) {}

	private async refresh(): Promise<void> {
		try {
			this.error = null;
			this.sessions = await this.actions.getSessions(this.scope);

			const needsInput: UnifiedSessionInfo[] = [];
			const working: UnifiedSessionInfo[] = [];
			const completed: UnifiedSessionInfo[] = [];

			for (const s of this.sessions) {
				if (s.state === "needs_input") needsInput.push(s);
				else if (s.state === "working") working.push(s);
				else completed.push(s);
			}

			const sortGroup = (arr: UnifiedSessionInfo[]) => {
				return arr.sort((a, b) => {
					if (a.pinned && !b.pinned) return -1;
					if (!a.pinned && b.pinned) return 1;
					if (a.isCurrent && !b.isCurrent) return -1;
					if (!a.isCurrent && b.isCurrent) return 1;
					return (b.modified?.getTime() || 0) - (a.modified?.getTime() || 0);
				});
			};

			const sortedNeedsInput = sortGroup(needsInput);
			const sortedWorking = sortGroup(working);
			const sortedCompleted = sortGroup(completed);

			this.displayList = [...sortedNeedsInput, ...sortedWorking, ...sortedCompleted];
			this.displayList.forEach((item, idx) => {
				item.index = idx + 1;
			});

			this.clampSelection();
		} catch (err: any) {
			this.error = String(err?.message || err);
		} finally {
			this.loading = false;
			this.requestRender();
		}
	}

	private clampSelection(): void {
		const max = Math.max(0, this.displayList.length - 1);
		this.selected = Math.max(0, Math.min(this.selected, max));
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.done();
	}

	handleInput(data: string): void {
		if (this.showHelp) {
			if (data === "?" || matchesKey(data, "escape") || isCtrl(data, "c")) {
				this.showHelp = false;
				this.requestRender();
			}
			return;
		}

		if (this.renameMode) {
			if (matchesKey(data, "escape")) {
				this.renameMode = false;
				this.requestRender();
				return;
			}
			if (matchesKey(data, "return") || matchesKey(data, "enter")) {
				const val = this.renameInput.getValue().trim();
				const item = this.displayList[this.selected];
				this.renameMode = false;
				if (item && val) {
					void this.actions.renameSession?.(item.sessionFile || item.id, val).then(() => this.refresh());
				}
				this.requestRender();
				return;
			}
			this.renameInput.handleInput(data);
			this.requestRender();
			return;
		}

		// Help overlay
		if (data === "?") {
			this.showHelp = true;
			this.requestRender();
			return;
		}

		// Esc logic
		if (matchesKey(data, "escape")) {
			if (this.taskInput.getValue().length > 0) {
				this.taskInput.setValue("");
				this.requestRender();
				return;
			}
			if (this.showPeek) {
				this.showPeek = false;
				this.requestRender();
				return;
			}
			this.close();
			return;
		}

		// Ctrl+C logic
		if (isCtrl(data, "c")) {
			if (this.taskInput.getValue().length > 0) {
				this.taskInput.setValue("");
				this.requestRender();
				return;
			}
			const now = Date.now();
			if (now - this.lastCtrlCTime < 2000) {
				this.close();
			} else {
				this.lastCtrlCTime = now;
				this.actions.notify("Press Ctrl+C again to quit", "warning");
			}
			return;
		}

		// Ctrl+S: Switch view (Current folder vs All folders)
		if (isCtrl(data, "s")) {
			this.scope = this.scope === "current" ? "all" : "current";
			this.selected = 0;
			this.actions.notify(`Switched view: ${this.scope === "current" ? "Current folder" : "All folders"}`, "info");
			void this.refresh();
			return;
		}

		// Ctrl+T: Pin to top
		if (isCtrl(data, "t")) {
			const item = this.displayList[this.selected];
			if (item) {
				this.actions.togglePinSession?.(item.sessionFile || item.id);
				void this.refresh();
			}
			return;
		}

		// Ctrl+R: Rename
		if (isCtrl(data, "r")) {
			const item = this.displayList[this.selected];
			if (item) {
				this.renameMode = true;
				setInputValueAtEnd(this.renameInput, item.name || "");
				this.requestRender();
			}
			return;
		}

		// Ctrl+X: Stop / Kill
		if (isCtrl(data, "x")) {
			const item = this.displayList[this.selected];
			if (item) {
				if (item.isCurrent) {
					this.actions.notify("Cannot stop the current foreground session.", "warning");
					return;
				}
				void this.actions.killSession(item.id).then(() => this.refresh());
			}
			return;
		}

		// Alt+1 .. Alt+9: Quick attach
		const altNum = isAltDigit(data);
		if (altNum !== null) {
			const target = this.displayList[altNum - 1];
			if (target) {
				if (target.isLive) {
					void this.actions.switchTo(target.id).then(() => this.close());
				} else {
					void this.actions.resumeSession(target.sessionFile || target.id).then(() => this.close());
				}
			}
			return;
		}

		// Navigation: Up
		if (matchesKey(data, "up") || isCtrl(data, "p")) {
			this.selected = Math.max(0, this.selected - 1);
			this.requestRender();
			return;
		}

		// Navigation: Down
		if (matchesKey(data, "down") || isCtrl(data, "n")) {
			this.selected = Math.min(this.displayList.length - 1, this.selected + 1);
			this.requestRender();
			return;
		}

		// Space: Toggle peek panel if taskInput is empty
		if (data === " ") {
			if (!this.taskInput.getValue()) {
				this.showPeek = !this.showPeek;
				this.requestRender();
				return;
			}
		}

		// Ctrl+J: Insert newline
		if (isCtrl(data, "j")) {
			this.taskInput.handleInput("\n");
			this.requestRender();
			return;
		}

		// Enter / Return / Right Arrow
		if (matchesKey(data, "return") || matchesKey(data, "enter") || (data === "\x1b[C" && !this.taskInput.getValue())) {
			const taskText = this.taskInput.getValue().trim();
			if (taskText) {
				// Dispatch new task in background!
				this.taskInput.setValue("");
				if (this.actions.dispatchSession) {
					void this.actions.dispatchSession(taskText).then(() => {
						this.actions.notify("Session dispatched in background", "info");
						return this.refresh();
					});
				}
				this.requestRender();
				return;
			}

			// Open/attach selected session
			const selected = this.displayList[this.selected];
			if (!selected) return;
			if (selected.isLive) {
				void this.actions.switchTo(selected.id).then(() => this.close());
			} else {
				void this.actions.resumeSession(selected.sessionFile || selected.id).then(() => this.close());
			}
			return;
		}

		// Forward everything else to taskInput
		this.taskInput.handleInput(data);
		this.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		const border = (color: "accent" | "dim" = "dim") =>
			th.fg(color, "─".repeat(Math.max(0, width)));
		const accent = (s: string) => th.fg("accent", s);
		const dim = (s: string) => th.fg("dim", s);
		const muted = (s: string) => th.fg("muted", s);
		const bold = (s: string) => th.bold(s);

		const lines: string[] = [];

		// Banner
		const banner = "Your conversation moved to the background — enter opens it · esc returns to it · ctrl+c twice quits";
		const viewLabel = this.scope === "current" ? "Current folder" : "All folders";
		lines.push(accent(banner) + dim(`  ·  [${viewLabel}]`));
		lines.push("");

		const needsInput: UnifiedSessionInfo[] = [];
		const working: UnifiedSessionInfo[] = [];
		const completed: UnifiedSessionInfo[] = [];

		for (const s of this.displayList) {
			if (s.state === "needs_input") needsInput.push(s);
			else if (s.state === "working") working.push(s);
			else completed.push(s);
		}

		let globalIndex = 0;

		const renderGroup = (title: string, items: UnifiedSessionInfo[], iconType: "active" | "bullet") => {
			if (items.length === 0) return;
			lines.push(bold(title));
			for (const item of items) {
				const isSelected = globalIndex === this.selected;
				globalIndex++;

				const marker = isSelected ? accent("› ") : "  ";
				const icon = iconType === "active" ? accent("✻ ") : dim("∙ ");
				const name = item.isCurrent ? "current session" : (item.name || "session");
				const styledName = item.pinned
					? bold(name) + dim(" 📌")
					: isSelected
						? bold(name)
						: name;

				// Width allocations
				const nameColWidth = 24;
				const branchColWidth = 16;
				const tagText = item.index !== undefined && item.index <= 9 ? dim(`#${item.index} `) : "";
				const timeText = dim(formatRelativeTime(item.modified));
				const rightPart = `${tagText}${timeText}`;
				const rightWidth = visibleWidth(rightPart);

				const leftPart = `${marker}${icon}${styledName}`;
				const leftPadded = padVisible(leftPart, nameColWidth + 4);

				const branchPart = item.branch ? dim(`⑂ ${item.branch}`) : "";
				const branchPadded = padVisible(branchPart, branchColWidth);

				const usedWidth = visibleWidth(leftPadded) + visibleWidth(branchPadded) + rightWidth + 4;
				const summaryWidth = Math.max(10, width - usedWidth);
				const summaryText = muted(truncateToWidth(item.summary || "", summaryWidth, "…"));

				const row = `${leftPadded}${branchPadded}${padVisible(summaryText, summaryWidth)}  ${rightPart}`;
				lines.push(isSelected ? th.bg("selectedBg", row) : row);
			}
			lines.push("");
		};

		renderGroup("Needs input", needsInput, "active");
		renderGroup("Working", working, "active");
		renderGroup("Completed", completed, "bullet");

		if (this.displayList.length === 0) {
			lines.push(dim("  No sessions found."));
			lines.push("");
		}

		// Peek Panel
		if (this.showPeek) {
			const selectedItem = this.displayList[this.selected];
			lines.push(border("dim"));
			const peekTitle = selectedItem ? ` Peek: ${selectedItem.name} ` : " Peek ";
			lines.push(bold(peekTitle) + dim("─".repeat(Math.max(0, width - visibleWidth(peekTitle)))));
			const transcriptText = selectedItem?.summary || "(no recent activity)";
			const parts = transcriptText.split("\n");
			for (const p of parts.slice(-6)) {
				lines.push(padVisible(`  ${muted(p)}`, width));
			}
			lines.push(border("dim"));
		}

		// Help modal overlay
		if (this.showHelp) {
			lines.push(border("accent"));
			lines.push(bold(" Keyboard Shortcuts "));
			lines.push(dim("  Enter          Attach to session (if prompt empty) or dispatch new task"));
			lines.push(dim("  Ctrl+Enter     Dispatch and attach immediately"));
			lines.push(dim("  Esc            Clear prompt, close peek, or return to conversation"));
			lines.push(dim("  Ctrl+C         Clear prompt; press twice to quit"));
			lines.push(dim("  Ctrl+S         Switch view (Current folder vs All folders)"));
			lines.push(dim("  Ctrl+T         Pin / unpin selected session to top"));
			lines.push(dim("  Ctrl+R         Rename selected session"));
			lines.push(dim("  Ctrl+X         Stop / kill selected live session"));
			lines.push(dim("  Alt+1..Alt+9   Directly open session #1 through #9"));
			lines.push(dim("  Space          Toggle transcript peek panel"));
			lines.push(dim("  Ctrl+J         Insert newline into prompt"));
			lines.push(dim("  ?              Close help"));
			lines.push(border("accent"));
		}

		// Fill remaining vertical space to push footer to bottom
		const termHeight = process.stdout.rows || 24;
		const footerHeight = 5;
		const remaining = Math.max(1, termHeight - lines.length - footerHeight);
		for (let i = 0; i < remaining; i++) {
			lines.push(" ".repeat(width));
		}

		// Bottom section
		lines.push(border("dim"));
		if (this.renameMode) {
			const prompt = accent("Rename: ");
			const inputRendered = renderInputChild(this.renameInput, width - 12);
			lines.push(padVisible(`${prompt}${inputRendered}`, width));
			lines.push(border("dim"));
			lines.push(padVisible(dim("  enter to save          esc to cancel"), width));
			lines.push("");
		} else {
			const prompt = accent("❯ ");
			const inputRendered = renderInputChild(this.taskInput, width - 4);
			const placeholder = this.taskInput.getValue()
				? inputRendered
				: dim("describe a task for a new session");
			lines.push(padVisible(`${prompt}${placeholder}`, width));
			lines.push(border("dim"));
			lines.push(
				padVisible(
					dim("  ctrl+r to rename          ctrl+j for newline    ctrl+t to pin to top    ctrl+x to stop    ? to close"),
					width,
				),
			);
			lines.push(
				padVisible(
					dim("  ctrl+s to switch views    @ to mention          alt+1 to open           esc to quit"),
					width,
				),
			);
		}

		return lines;
	}

	invalidate(): void {
		this.taskInput.invalidate();
		this.renameInput.invalidate();
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
	}
}

export async function showSessionsView(
	ctx: any,
	actions: SessionsActions,
): Promise<void> {
	await ctx.ui.custom(
		(tui: any, theme: any, _keybindings: any, done: () => void) =>
			new SessionsView(theme, done, actions, () => tui.requestRender()),
	);
}
