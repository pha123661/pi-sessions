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
	getSessions: (orgMode: "state" | "directory") => Promise<UnifiedSessionInfo[]>;
	getResumeSessions?: () => Promise<SavedSessionInfo[]>;
	getAttached: () => string | null;
	getCwd: () => string;
	switchTo: (id: string) => Promise<void>;
	dispatchSession?: (prompt: string, cwd?: string) => Promise<string>;
	retrieveSession?: (sessionPath: string) => Promise<void>;
	resumeSession: (sessionPath?: string) => Promise<string | void>;
	renameSession?: (idOrPath: string, newName: string) => Promise<void>;
	togglePinSession?: (idOrPath: string) => void;
	removeSession?: (idOrPath: string) => Promise<void>;
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

function isCtrl(
	data: string,
	key: "o" | "r" | "k" | "p" | "n" | "s" | "t" | "x" | "j" | "c",
): boolean {
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

function padVisible(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "…");
	const padding = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	return truncateToWidth(truncated + padding, width);
}

function renderInputChild(input: Input, width: number): string {
	const line = input.render(Math.max(1, width))[0] ?? "";
	return line.startsWith("> ") ? line.slice(2) : line;
}

function renderTaskInput(
	input: Input,
	width: number,
	theme: any,
	placeholder = "describe a task for a new session",
): string {
	input.focused = true;
	const prompt = theme.fg("accent", "❯ ");
	const promptWidth = visibleWidth(prompt);
	const availableWidth = Math.max(10, width - promptWidth);
	const rendered = input.render(availableWidth)[0] ?? "";
	const content = rendered.startsWith("> ") ? rendered.slice(2) : rendered;

	if (!input.getValue()) {
		const cursorEndIdx = content.indexOf("\x1b[27m");
		if (cursorEndIdx !== -1) {
			const cursorPart = content.slice(0, cursorEndIdx + 5);
			const phText = theme.fg("dim", ` ${placeholder}`);
			const combined = `${prompt}${cursorPart}${phText}`;
			const pad = " ".repeat(Math.max(0, width - visibleWidth(combined)));
			return truncateToWidth(`${combined}${pad}`, width);
		}
	}
	const fullLine = `${prompt}${content}`;
	const pad = " ".repeat(Math.max(0, width - visibleWidth(fullLine)));
	return truncateToWidth(`${fullLine}${pad}`, width);
}

function shortenPath(p: string): string {
	const home = homedir();
	if (!p) return p;
	if (p.startsWith(home)) {
		return `~${p.slice(home.length)}`;
	}
	return p;
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

// ---------------------------------------------------------------------------
// ResumeSessionPicker (For retrieving dead sessions via @)
// ---------------------------------------------------------------------------
const RESUME_MAX_VISIBLE = 10;

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
			const s = this.filteredSessions()[this.selected];
			this.onDone(s ? s.path : null);
			return;
		}
		const before = this.filterInput.getValue();
		this.filterInput.handleInput(data);
		if (this.filterInput.getValue() !== before) {
			this.selected = 0;
			this.clampSelection();
		}
		this.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		const border = (color: "accent" | "dim" = "dim") =>
			th.fg(color, "─".repeat(Math.max(0, width)));
		const accent = (s: string) => th.fg("accent", s);
		const dim = (s: string) => th.fg("dim", s);
		const muted = (s: string) => th.fg("muted", s);

		const lines: string[] = [];
		const visible = this.filteredSessions();
		const total = Math.max(1, visible.length);
		const index = Math.min(this.selected + 1, total);
		const prefix = `Retrieve Session (${index}/${total}): `;
		const renderedInput = renderInputChild(this.filterInput, width - visibleWidth(prefix) - 2);

		lines.push(border("accent"));
		lines.push(accent(`${prefix}${renderedInput}`));
		lines.push(border("dim"));

		const startIdx = this.visibleStart(visible.length);
		const endIdx = Math.min(visible.length, startIdx + RESUME_MAX_VISIBLE);

		if (this.loading) {
			lines.push(dim("  Loading saved sessions…"));
		} else if (visible.length === 0) {
			lines.push(dim("  No sessions found."));
		} else {
			for (let i = startIdx; i < endIdx; i++) {
				const s = visible[i];
				const isSelected = i === this.selected;
				const marker = isSelected ? accent("› ") : "  ";
				const title = s.name || s.firstMessage || s.id;
				const cwd = s.cwd ? dim(shortenPath(s.cwd)) : "";
				const time = s.modified ? dim(formatRelativeTime(s.modified)) : "";
				const row = `${marker}${padVisible(title, 40)}  ${cwd}  ${time}`;
				lines.push(isSelected ? th.bg("selectedBg", padVisible(row, width)) : padVisible(row, width));
			}
		}

		lines.push(border("dim"));
		lines.push(dim("  enter to retrieve into agent view · esc to cancel"));
		return lines.map((l) => truncateToWidth(l, width));
	}

	invalidate(): void {
		this.filterInput.invalidate();
	}

	dispose(): void {}
}

// ---------------------------------------------------------------------------
// Selectable Rows Model
// ---------------------------------------------------------------------------
type SelectableRow =
	| {
			type: "header";
			sectionKey: string;
			title: string;
			count: number;
			isCollapsed: boolean;
	  }
	| {
			type: "session";
			item: UnifiedSessionInfo;
	  };

// ---------------------------------------------------------------------------
// Agent View Main Component
// ---------------------------------------------------------------------------
class SessionsView {
	private sessions: UnifiedSessionInfo[] = [];
	private selectableRows: SelectableRow[] = [];
	private selected = 0;
	private orgMode: "state" | "directory" = "state";
	private collapsedSections = new Set<string>();
	private showShortcuts = false;
	private loading = true;
	private error: string | null = null;
	private closed = false;
	private readonly taskInput = new Input();
	private renameMode = false;
	private readonly renameInput = new Input();
	private showPeek = false;
	private resumePicker: ResumeSessionPicker | null = null;
	private lastCtrlCTime = 0;
	private timer: NodeJS.Timeout | null = null;
	private inlineNotice: { text: string; type: "info" | "warning" | "error" } | null = null;
	private noticeTimer: NodeJS.Timeout | null = null;

	constructor(
		private readonly theme: any,
		private readonly done: () => void,
		private readonly actions: SessionsActions,
		private readonly requestRender: () => void,
	) {
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
			this.sessions = await this.actions.getSessions(this.orgMode);
			this.buildSelectableRows();
			this.clampSelection();
		} catch (err: any) {
			this.error = String(err?.message || err);
		} finally {
			this.loading = false;
			this.requestRender();
		}
	}

	private buildSelectableRows(): void {
		const rows: SelectableRow[] = [];

		// 1. Pinned sessions (rendered at the top in BOTH views)
		const pinnedSessions = this.sessions.filter((s) => s.pinned);
		if (pinnedSessions.length > 0) {
			const isCollapsed = this.collapsedSections.has("pinned");
			rows.push({
				type: "header",
				sectionKey: "pinned",
				title: "Pinned",
				count: pinnedSessions.length,
				isCollapsed,
			});
			if (!isCollapsed) {
				for (const s of pinnedSessions) {
					rows.push({ type: "session", item: s });
				}
			}
		}

		// 2. Unpinned sessions
		const unpinned = this.sessions.filter((s) => !s.pinned);

		if (this.orgMode === "state") {
			const needsInput = unpinned.filter((s) => s.state === "needs_input");
			const working = unpinned.filter((s) => s.state === "working");
			const completed = unpinned.filter((s) => s.state === "completed");

			if (needsInput.length > 0) {
				const isCollapsed = this.collapsedSections.has("needs_input");
				rows.push({
					type: "header",
					sectionKey: "needs_input",
					title: "Needs input",
					count: needsInput.length,
					isCollapsed,
				});
				if (!isCollapsed) {
					for (const s of needsInput) rows.push({ type: "session", item: s });
				}
			}

			if (working.length > 0) {
				const isCollapsed = this.collapsedSections.has("working");
				rows.push({
					type: "header",
					sectionKey: "working",
					title: "Working",
					count: working.length,
					isCollapsed,
				});
				if (!isCollapsed) {
					for (const s of working) rows.push({ type: "session", item: s });
				}
			}

			if (completed.length > 0) {
				const isCollapsed = this.collapsedSections.has("completed");
				rows.push({
					type: "header",
					sectionKey: "completed",
					title: `Completed ${completed.length}`,
					count: completed.length,
					isCollapsed,
				});
				if (!isCollapsed) {
					for (const s of completed) rows.push({ type: "session", item: s });
				}
			}
		} else {
			// Group by Directory
			const byDir = new Map<string, UnifiedSessionInfo[]>();
			for (const s of unpinned) {
				const dir = s.cwd || "other";
				if (!byDir.has(dir)) byDir.set(dir, []);
				byDir.get(dir)!.push(s);
			}

			for (const [dir, dirSessions] of byDir.entries()) {
				const sectionKey = `dir:${dir}`;
				const isCollapsed = this.collapsedSections.has(sectionKey);
				rows.push({
					type: "header",
					sectionKey,
					title: `${shortenPath(dir)} (${dirSessions.length})`,
					count: dirSessions.length,
					isCollapsed,
				});
				if (!isCollapsed) {
					for (const s of dirSessions) rows.push({ type: "session", item: s });
				}
			}
		}

		// Assign 1-based sequential indices to session items for Alt+1..Alt+9
		let sessionIndex = 1;
		for (const r of rows) {
			if (r.type === "session") {
				r.item.index = sessionIndex++;
			}
		}

		this.selectableRows = rows;
	}

	private clampSelection(): void {
		const max = Math.max(0, this.selectableRows.length - 1);
		this.selected = Math.max(0, Math.min(this.selected, max));
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		if (this.noticeTimer) clearTimeout(this.noticeTimer);
		this.done();
	}

	notify(message: string, type: "info" | "warning" | "error" = "info"): void {
		if (this.noticeTimer) {
			clearTimeout(this.noticeTimer);
			this.noticeTimer = null;
		}
		this.inlineNotice = { text: message, type };
		this.requestRender();
		this.noticeTimer = setTimeout(() => {
			this.inlineNotice = null;
			this.requestRender();
		}, 3500);
	}

	private getSelectedRow(): SelectableRow | undefined {
		return this.selectableRows[this.selected];
	}

	handleInput(data: string): void {
		if (this.resumePicker) {
			this.resumePicker.handleInput(data);
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
				const row = this.getSelectedRow();
				this.renameMode = false;
				if (row && row.type === "session" && val) {
					void this.actions.renameSession?.(row.item.sessionFile || row.item.id, val).then(() => this.refresh());
				}
				this.requestRender();
				return;
			}
			this.renameInput.handleInput(data);
			this.requestRender();
			return;
		}

		// -------------------------------------------------------------------
		// When Task Input IS NOT EMPTY:
		// Normal typing mode (characters go into the input, including ?, @, space)
		// -------------------------------------------------------------------
		if (this.taskInput.getValue().length > 0) {
			// Esc or Ctrl+C: clear input
			if (matchesKey(data, "escape") || isCtrl(data, "c")) {
				this.taskInput.setValue("");
				this.requestRender();
				return;
			}

			// Enter: dispatch task in background
			if (matchesKey(data, "return") || matchesKey(data, "enter")) {
				const taskText = this.taskInput.getValue().trim();
				if (taskText) {
					this.taskInput.setValue("");
					if (this.actions.dispatchSession) {
						void this.actions.dispatchSession(taskText).then(() => {
							this.notify("Session dispatched in background", "info");
							return this.refresh();
						});
					}
				}
				this.requestRender();
				return;
			}

			// Forward character / arrow / edit keys to native Input
			this.taskInput.handleInput(data);
			this.requestRender();
			return;
		}

		// -------------------------------------------------------------------
		// When Task Input IS EMPTY:
		// Navigation and shortcut mode
		// -------------------------------------------------------------------

		// ? : Toggle shortcuts footer
		if (data === "?") {
			this.showShortcuts = !this.showShortcuts;
			this.requestRender();
			return;
		}

		// @ : Open Session Retrieval Picker (to revive dead sessions)
		if (data === "@") {
			if (this.actions.getResumeSessions) {
				this.resumePicker = new ResumeSessionPicker(
					this.theme,
					this.actions.getResumeSessions,
					(sessionPath) => {
						this.resumePicker = null;
						if (sessionPath) {
							void this.actions.retrieveSession?.(sessionPath).then(() => this.refresh());
						}
						this.requestRender();
					},
					this.requestRender,
				);
				this.requestRender();
			}
			return;
		}

		// Ctrl+S: Switch view (state vs directory)
		if (isCtrl(data, "s")) {
			this.orgMode = this.orgMode === "state" ? "directory" : "state";
			this.selected = 0;
			this.notify(
				`Switched view: ${this.orgMode === "state" ? "Group by State" : "Group by Directory"}`,
				"info",
			);
			void this.refresh();
			return;
		}

		// Ctrl+T: Pin to top
		if (isCtrl(data, "t")) {
			const row = this.getSelectedRow();
			if (row && row.type === "session") {
				this.actions.togglePinSession?.(row.item.sessionFile || row.item.id);
				void this.refresh();
			}
			return;
		}

		// Ctrl+R: Rename
		if (isCtrl(data, "r")) {
			const row = this.getSelectedRow();
			if (row && row.type === "session") {
				this.renameMode = true;
				this.renameInput.setValue(row.item.name || "");
				this.requestRender();
			}
			return;
		}

		// Ctrl+X: Remove from multiplexer
		if (isCtrl(data, "x")) {
			const row = this.getSelectedRow();
			if (row && row.type === "session") {
				if (row.item.isCurrent) {
					this.notify("Cannot remove current foreground session.", "warning");
					return;
				}
				void this.actions.removeSession?.(row.item.id).then(() => this.refresh());
			}
			return;
		}

		// Alt+1 .. Alt+9: Quick attach
		const altNum = isAltDigit(data);
		if (altNum !== null) {
			const targetRow = this.selectableRows.find(
				(r) => r.type === "session" && r.item.index === altNum,
			);
			if (targetRow && targetRow.type === "session") {
				if (targetRow.item.isLive) {
					void this.actions.switchTo(targetRow.item.id).then(() => this.close());
				} else {
					void this.actions.resumeSession(targetRow.item.sessionFile || targetRow.item.id).then(() => this.close());
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
			this.selected = Math.min(this.selectableRows.length - 1, this.selected + 1);
			this.requestRender();
			return;
		}

		// Space:
		// - If on header: collapse/expand
		// - If on session: toggle peek panel
		if (data === " ") {
			const row = this.getSelectedRow();
			if (row && row.type === "header") {
				if (this.collapsedSections.has(row.sectionKey)) {
					this.collapsedSections.delete(row.sectionKey);
				} else {
					this.collapsedSections.add(row.sectionKey);
				}
				this.buildSelectableRows();
				this.clampSelection();
				this.requestRender();
				return;
			}
			this.showPeek = !this.showPeek;
			this.requestRender();
			return;
		}

		// Enter:
		// - If on header: collapse/expand
		// - If on session: attach/open
		if (matchesKey(data, "return") || matchesKey(data, "enter") || data === "\x1b[C") {
			const row = this.getSelectedRow();
			if (row && row.type === "header") {
				if (this.collapsedSections.has(row.sectionKey)) {
					this.collapsedSections.delete(row.sectionKey);
				} else {
					this.collapsedSections.add(row.sectionKey);
				}
				this.buildSelectableRows();
				this.clampSelection();
				this.requestRender();
				return;
			}

			if (row && row.type === "session") {
				if (row.item.isLive) {
					void this.actions.switchTo(row.item.id).then(() => this.close());
				} else {
					void this.actions.resumeSession(row.item.sessionFile || row.item.id).then(() => this.close());
				}
				return;
			}
		}

		// Esc: close peek panel or close agent view
		if (matchesKey(data, "escape")) {
			if (this.showPeek) {
				this.showPeek = false;
				this.requestRender();
				return;
			}
			this.close();
			return;
		}

		// Ctrl+C: double-tap quit
		if (isCtrl(data, "c")) {
			const now = Date.now();
			if (now - this.lastCtrlCTime < 2000) {
				this.close();
			} else {
				this.lastCtrlCTime = now;
				this.notify("Press Ctrl+C again to quit", "warning");
			}
			return;
		}

		// Any other key starts typing into the input
		this.taskInput.handleInput(data);
		this.requestRender();
	}

	render(width: number): string[] {
		if (this.resumePicker) return this.resumePicker.render(width);

		const th = this.theme;
		const border = (color: "accent" | "dim" = "dim") =>
			th.fg(color, "─".repeat(Math.max(0, width)));
		const accent = (s: string) => th.fg("accent", s);
		const dim = (s: string) => th.fg("dim", s);
		const muted = (s: string) => th.fg("muted", s);
		const bold = (s: string) => th.bold(s);

		const lines: string[] = [];

		// 1. Minimal Top Context Banner
		const banner =
			"Your conversation moved to the background — enter opens it · esc returns to it · ctrl+c twice quits";
		const viewModeLabel = this.orgMode === "state" ? "Group by State" : "Group by Directory";
		lines.push(accent(banner) + dim(`  ·  [${viewModeLabel}]`));

		if (this.inlineNotice) {
			const icon =
				this.inlineNotice.type === "warning"
					? "⚠ "
					: this.inlineNotice.type === "error"
						? "✖ "
						: "ℹ ";
			const color =
				this.inlineNotice.type === "warning"
					? "warning"
					: this.inlineNotice.type === "error"
						? "error"
						: "accent";
			lines.push(th.fg(color as any, `  ${icon}${this.inlineNotice.text}`));
		} else {
			lines.push("");
		}

		// 2. Render Selectable Rows (Headers & Session Rows)
		for (let i = 0; i < this.selectableRows.length; i++) {
			const row = this.selectableRows[i];
			const isSelected = i === this.selected;

			if (row.type === "header") {
				// Section header line
				const marker = isSelected ? accent("› ") : "  ";
				const collapseHint = isSelected
					? dim(row.isCollapsed ? " (space to expand)" : " (space to collapse)")
					: "";
				const headerLine = `${marker}${bold(row.title)}${collapseHint}`;
				lines.push(headerLine);
			} else {
				// Session row
				const item = row.item;
				const marker = isSelected ? accent("› ") : "  ";
				const icon =
					item.state === "working"
						? accent("✻ ")
						: item.state === "needs_input"
							? accent("✻ ")
							: dim("∙ ");

				const name = item.isCurrent ? "current session" : (item.name || "session");
				const styledName = item.pinned
					? bold(name) + dim(" 📌")
					: isSelected
						? bold(name)
						: name;

				const nameColWidth = 24;
				const branchColWidth = 16;
				const tagText =
					item.index !== undefined && item.index <= 9 ? dim(`#${item.index} `) : "";
				const timeText = dim(formatRelativeTime(item.modified));
				const rightPart = `${tagText}${timeText}`;
				const rightWidth = visibleWidth(rightPart);

				const leftPart = `${marker} ${icon}${styledName}`;
				const leftPadded = padVisible(leftPart, nameColWidth + 6);

				const branchPart = item.branch ? dim(`⑂ ${item.branch}`) : "";
				const branchPadded = padVisible(branchPart, branchColWidth);

				const usedWidth = visibleWidth(leftPadded) + visibleWidth(branchPadded) + rightWidth + 4;
				const summaryWidth = Math.max(10, width - usedWidth);
				const summaryText = muted(truncateToWidth(item.summary || "", summaryWidth, "…"));

				const sessionLine = `${leftPadded}${branchPadded}${padVisible(summaryText, summaryWidth)}  ${rightPart}`;
				lines.push(isSelected ? th.bg("selectedBg", sessionLine) : sessionLine);
			}
		}

		if (this.selectableRows.length === 0) {
			lines.push(dim("  No sessions in agent view. Press @ to retrieve past sessions."));
			lines.push("");
		}

		// 3. Peek Panel (if active)
		if (this.showPeek) {
			const row = this.getSelectedRow();
			const selectedItem = row && row.type === "session" ? row.item : undefined;
			lines.push(border("dim"));
			const peekTitle = selectedItem ? ` Peek: ${selectedItem.name} ` : " Peek ";
			lines.push(bold(peekTitle) + dim("─".repeat(Math.max(0, width - visibleWidth(peekTitle)))));
			const transcriptText = selectedItem?.summary || "(no recent activity)";
			for (const p of transcriptText.split("\n").slice(-6)) {
				lines.push(padVisible(`  ${muted(p)}`, width));
			}
			lines.push(border("dim"));
		}

		// 4. Fill vertical blank lines to anchor input bar at bottom
		const termHeight = process.stdout.rows || 24;
		const footerHeight = this.showShortcuts ? 2 : 1;
		const bottomAreaHeight = 2 + 1 + footerHeight; // rules + 1-line prompt + footer
		const remaining = Math.max(1, termHeight - lines.length - bottomAreaHeight);
		for (let i = 0; i < remaining; i++) {
			lines.push(" ".repeat(width));
		}

		// 5. Prompt Bar
		lines.push(border("dim"));
		if (this.renameMode) {
			const prompt = accent("Rename: ");
			const inputRendered = renderInputChild(this.renameInput, width - 12);
			lines.push(padVisible(`${prompt}${inputRendered}`, width));
		} else {
			lines.push(renderTaskInput(this.taskInput, width, th));
		}
		lines.push(border("dim"));

		// 6. Footer (Collapsed vs Expanded)
		if (this.renameMode) {
			lines.push(padVisible(dim("  enter to save          esc to cancel"), width));
		} else if (!this.showShortcuts) {
			// Collapsed footer bar (default)
			const collapsedText =
				"  enter to open · space to collapse · ctrl+x to stop · @ to retrieve · ? for shortcuts";
			lines.push(padVisible(dim(collapsedText), width));
		} else {
			// Expanded footer bar (after ? pressed)
			const line1 =
				"  ctrl+s to switch views    ctrl+t to pin to top    @ retrieve session    esc to quit";
			const line2 =
				"  ctrl+r to rename          alt+1 to open           ctrl+x to remove      ? to close";
			lines.push(padVisible(dim(line1), width));
			lines.push(padVisible(dim(line2), width));
		}

		return lines.map((l) => truncateToWidth(l, width));
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
