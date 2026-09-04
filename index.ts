// @ts-nocheck
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	getPackageDir,
	hasTrustRequiringProjectResources,
	InteractiveMode,
	ProjectTrustStore,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { SessionWidget, showSessionsView } from "./ui.ts";

const PARENT_SESSION_ID = "__parent__";
const HOST_KEY = "__PI_SESSIONS_HOST__";
const INTERACTIVE_MODE_SPINNER_PATCHED = Symbol.for(
	"pi-sessions.interactiveMode.spinnerPatched",
);

type ExtensionAPI = any;
type CommandContext = any;
type Activity = "idle" | "working" | "waiting";
type LiveState = "active" | "suspended" | "starting" | "stopped" | "error";
type WorkingIndicatorOptions = { frames?: string[]; intervalMs?: number };

type LiveSessionRecord = {
	id: string;
	kind: "parent" | "child";
	name: string;
	cwd: string;
	state: LiveState;
	activity: Activity;
	sessionFile?: string;
	sessionId?: string;
	parentSessionFile?: string;
	parentLeafId?: string | null;
	createdAt: number;
	lastActivityAt: number;
	status?: string;
	transcript?: string;
	runtime?: any;
	mode?: any;
	adapter?: InteractiveModeAdapter;
	sessionManager?: any;
	context?: CommandContext;
	inheritance?: any;
	started?: boolean;
	runPromise?: Promise<void>;
	expectedStop?: boolean;
	error?: string;
};

function readFirstMessage(filePath: string | undefined): string {
	if (!filePath) return "";
	try {
		const content = fs.readFileSync(filePath, "utf8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (entry.type !== "message") continue;
				const msg = entry.message;
				if (!msg || msg.role !== "user") continue;
				const text =
					typeof msg.content === "string"
						? msg.content
						: Array.isArray(msg.content)
							? msg.content
									.filter((p: any) => p.type === "text")
									.map((p: any) => p.text)
									.join(" ")
							: "";
				if (text.trim()) return text.trim().slice(0, 200);
			} catch {}
		}
	} catch {}
	return "";
}

function resolveTranscriptName(
	sessionName?: string,
	sessionFile?: string,
): string {
	return sessionName || readFirstMessage(sessionFile) || "";
}

function sanitizeName(name: string): string {
	return (
		String(name || "")
			.trim()
			.replace(/[^a-zA-Z0-9_.-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 64) || `session-${Date.now().toString(36)}`
	);
}

let modelResolverPromise: Promise<any> | null = null;
const runtimeInheritanceBySessionManager = new WeakMap<object, any>();

async function loadModelResolver(): Promise<any> {
	modelResolverPromise ??= import(
		pathToFileURL(path.join(getPackageDir(), "dist/core/model-resolver.js"))
			.href
	);
	return await modelResolverPromise;
}

function sameModel(a: any, b: any): boolean {
	return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

function hasExistingMessages(sessionManager: any): boolean {
	return (sessionManager.buildSessionContext?.().messages?.length ?? 0) > 0;
}

function resetExtendedKeyboardModesForHandoff(): void {
	if (!process.stdin.isTTY) return;
	process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[<u");
}

function safeCollectRuntimeInheritance(ctx?: CommandContext): any {
	if (!ctx) return undefined;
	const mode = (ctx as any).mode;
	const session = ctx.sessionManager;
	return {
		cwd: ctx.cwd,
		model: ctx.model,
		thinkingLevel: ctx.thinkingLevel,
		sessionFile: session?.getSessionFile?.(),
		sessionId: session?.getSessionId?.(),
		leafId: session?.getLeafId?.(),
		isBashMode: mode?.isBashMode,
	};
}

function needsPermission(
	toolName: string,
	input: any,
	sessionName: string,
): string | null {
	if (toolName === "bash") {
		const command = String(input?.command || "");
		if (command.includes("rm ") || command.includes("dropdb")) {
			return `Session "${sessionName}" wants to run potentially destructive bash: ${command.slice(0, 100)}`;
		}
	}
	return null;
}

const branchCache = new Map<string, { branch: string; time: number }>();

function getGitBranch(cwd: string): string {
	if (!cwd) return "";
	const cached = branchCache.get(cwd);
	if (cached && Date.now() - cached.time < 10000) {
		return cached.branch;
	}
	try {
		const branch = execSync("git rev-parse --abbrev-ref HEAD", {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 1000,
		}).trim();
		branchCache.set(cwd, { branch, time: Date.now() });
		return branch;
	} catch {
		branchCache.set(cwd, { branch: "", time: Date.now() });
		return "";
	}
}

function getDefaultScope(): "current" | "all" {
	try {
		const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
		if (fs.existsSync(settingsPath)) {
			const raw = fs.readFileSync(settingsPath, "utf8");
			const data = JSON.parse(raw);
			if (data?.sessions?.defaultScope === "all" || data?.sessionsDefaultScope === "all") {
				return "all";
			}
		}
	} catch {}
	return "current";
}

// ---------------------------------------------------------------------------
// Multiplexed Sessions Persistent Registry
// ---------------------------------------------------------------------------
const REGISTRY_FILE = path.join(os.homedir(), ".pi", "agent", "multiplexed-sessions.json");

export interface StoredMultiplexSession {
	id: string;
	sessionFile: string;
	cwd: string;
	name: string;
	pinned?: boolean;
	createdAt: number;
	lastActivityAt: number;
}

function loadMultiplexRegistry(): StoredMultiplexSession[] {
	try {
		if (fs.existsSync(REGISTRY_FILE)) {
			const raw = fs.readFileSync(REGISTRY_FILE, "utf8");
			const list: StoredMultiplexSession[] = JSON.parse(raw).sessions || [];
			// Clean up any old entries where name was mistakenly saved as literal "current session"
			for (const s of list) {
				if (s.name === "current session" && s.sessionFile && fs.existsSync(s.sessionFile)) {
					s.name = readFirstMessage(s.sessionFile) || path.basename(s.cwd) || "session";
				}
			}
			return list;
		}
	} catch {}
	return [];
}

function saveMultiplexRegistry(sessions: StoredMultiplexSession[]): void {
	try {
		const dir = path.dirname(REGISTRY_FILE);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(REGISTRY_FILE, JSON.stringify({ sessions }, null, 2));
	} catch {}
}

class PathLockManager {
	private locks = new Map<string, { sessionId: string; acquiredAt: number }>();

	acquire(sessionId: string, paths: string[]): { ok: boolean; conflict?: string } {
		const normalized = paths.map((p) => path.resolve(p));
		for (const p of normalized) {
			const existing = this.locks.get(p);
			if (existing && existing.sessionId !== sessionId) {
				return { ok: false, conflict: p };
			}
		}
		for (const p of normalized) {
			this.locks.set(p, { sessionId, acquiredAt: Date.now() });
		}
		return { ok: true };
	}

	release(sessionId: string, paths?: string[]): void {
		if (paths) {
			for (const p of paths.map((x) => path.resolve(x))) {
				const cur = this.locks.get(p);
				if (cur && cur.sessionId === sessionId) this.locks.delete(p);
			}
		} else {
			for (const [p, cur] of [...this.locks.entries()]) {
				if (cur.sessionId === sessionId) this.locks.delete(p);
			}
		}
	}
}

class InteractiveModeAdapter {
	state: "never-started" | "active" | "suspended" | "stopped" = "never-started";
	private terminalGateInstalled = false;
	private originalSetProgress?: any;
	private originalSetTitle?: any;

	constructor(
		readonly id: string,
		readonly runtime: any,
		readonly mode: any,
		private readonly host: PiSessionsHost,
	) {}

	get ui(): any {
		return (this.mode as any).ui;
	}

	installTerminalGate(): void {
		if (this.terminalGateInstalled) return;
		const terminal = this.ui?.terminal;
		if (!terminal) return;
		this.terminalGateInstalled = true;
		this.originalSetProgress = terminal.setProgress?.bind(terminal);
		this.originalSetTitle = terminal.setTitle?.bind(terminal);
		if (this.originalSetProgress) {
			terminal.setProgress = (active: boolean) => {
				if (this.host.activeId === this.id) this.originalSetProgress(active);
			};
		}
		if (this.originalSetTitle) {
			terminal.setTitle = (...args: any[]) => {
				if (this.host.activeId === this.id) this.originalSetTitle(...args);
			};
		}
	}

	start(): void {
		if (this.state !== "never-started") return this.resume();
		this.installTerminalGate();
		this.state = "active";
		const record = this.host.get(this.id);
		if (record) {
			record.started = true;
			record.state = "active";
			record.runPromise = this.mode.run().catch((error: any) => {
				record.state = record.expectedStop ? "stopped" : "error";
				record.error = String(error?.message || error);
				record.status = record.error;
				this.host.locks.release(record.id);
				this.host.notify();
			});
		} else {
			void this.mode.run();
		}
	}

	suspend(): void {
		if (this.state === "stopped") return;
		try {
			this.ui?.stop?.();
			resetExtendedKeyboardModesForHandoff();
		} catch {}
		this.state = "suspended";
		const record = this.host.get(this.id);
		if (record && record.state !== "stopped" && record.state !== "error")
			record.state = "suspended";
	}

	resume(): void {
		if (this.state === "stopped") return;
		this.installTerminalGate();
		try {
			this.ui?.start?.();
			this.ui?.requestRender?.(true);
		} catch {}
		this.state = "active";
		const record = this.host.get(this.id);
		if (record) record.state = "active";
	}

	async dispose(): Promise<void> {
		this.state = "stopped";
		const ui = this.ui;
		const originalUiStop = ui?.stop?.bind(ui);
		const canTouchTerminal = this.host.activeId === this.id;
		try {
			if (ui && originalUiStop && !canTouchTerminal) {
				ui.stop = () => {};
			}
			this.mode?.stop?.();
		} catch {
		} finally {
			if (ui && originalUiStop) ui.stop = originalUiStop;
		}
		try {
			await this.runtime?.dispose?.();
		} catch {}
	}
}

const createRuntime: CreateAgentSessionRuntimeFactory = async ({
	cwd,
	agentDir,
	sessionManager,
	sessionStartEvent,
}) => {
	const services = await createAgentSessionServices({ cwd, agentDir });
	let inheritance = runtimeInheritanceBySessionManager.get(sessionManager);
	let targetModel = inheritance?.model;

	if (targetModel && services.modelRuntime) {
		const availableModels = services.modelRuntime.getModels?.() || [];
		const found = availableModels.find((m: any) => sameModel(m, targetModel));
		if (!found) {
			targetModel = undefined;
		}
	}

	const session = await createAgentSessionFromServices({
		services,
		sessionManager,
		sessionStartEvent,
		model: targetModel,
		thinkingLevel: inheritance?.thinkingLevel,
	});

	return {
		session,
		services,
		diagnostics: services.diagnostics,
	};
};

class PiSessionsHost {
	activeId = PARENT_SESSION_ID;
	inAgentView = false;
	records = new Map<string, LiveSessionRecord>();
	locks = new PathLockManager();
	workingIndicator?: WorkingIndicatorOptions;
	subscribers = new Set<() => void>();
	private activationInProgress: Promise<void> | null = null;
	private queuedActivation: string | null = null;
	parentTui: any = null;
	parentDone: (() => void) | null = null;
	parentHandoffActive = false;

	constructor() {
		this.records.set(PARENT_SESSION_ID, {
			id: PARENT_SESSION_ID,
			kind: "parent",
			name: "parent",
			cwd: process.cwd(),
			state: "active",
			activity: "idle",
			createdAt: Date.now(),
			lastActivityAt: Date.now(),
		});
	}

	subscribe(fn: () => void): () => void {
		this.subscribers.add(fn);
		return () => this.subscribers.delete(fn);
	}

	notify(): void {
		for (const listener of [...this.subscribers]) {
			try {
				listener();
			} catch {}
		}
	}

	get(idOrName: string): LiveSessionRecord | undefined {
		if (this.records.has(idOrName)) return this.records.get(idOrName);
		for (const r of this.records.values()) {
			if (r.name === idOrName) return r;
			if (r.sessionFile === idOrName) return r;
		}
		return undefined;
	}

	publicSession(record: LiveSessionRecord): any {
		return {
			id: record.id,
			name: record.name,
			cwd: record.cwd,
			state: record.state,
			status: record.status || record.state,
			pid: process.pid,
			lastActivityAt: record.lastActivityAt,
			agentStatus: record.activity || "idle",
			transcript: record.transcript || "",
		};
	}

	snapshot(): any {
		return {
			attached: this.activeId,
			updatedAt: Date.now(),
			sessions: this.listLive().map((r) => this.publicSession(r)),
		};
	}

	listLive(): LiveSessionRecord[] {
		const parent = this.records.get(PARENT_SESSION_ID);
		const children = [...this.records.values()].filter(
			(r) => r.kind === "child" && !["stopped", "error"].includes(r.state),
		);
		return [parent, ...children].filter(Boolean);
	}

	registerParent(ctx: CommandContext): void {
		const record = this.records.get(PARENT_SESSION_ID)!;
		record.cwd = ctx.cwd || process.cwd();
		record.context = ctx;
		record.sessionManager = ctx.sessionManager;
		record.sessionFile = ctx.sessionManager?.getSessionFile?.();
		record.sessionId = ctx.sessionManager?.getSessionId?.();
		record.transcript = resolveTranscriptName(
			ctx.sessionManager?.getSessionName?.(),
			record.sessionFile,
		);
		record.lastActivityAt = Date.now();
		if (this.activeId === PARENT_SESSION_ID) record.state = "active";
		
		// Ensure in persistent registry
		if (record.sessionFile) {
			this.persistSessionRecord(record);
		}
		this.notify();
	}

	getActiveSessionFile(): string | undefined {
		const activeRecord = this.get(this.activeId);
		return activeRecord?.sessionFile || this.records.get(PARENT_SESSION_ID)?.sessionFile;
	}

	private persistSessionRecord(record: LiveSessionRecord): void {
		if (!record.sessionFile) return;
		const registry = loadMultiplexRegistry();
		const existingIdx = registry.findIndex(
			(s) => s.sessionFile === record.sessionFile,
		);
		const realName =
			(record.id !== PARENT_SESSION_ID ? record.name : undefined) ||
			record.context?.sessionManager?.getSessionName?.() ||
			record.sessionManager?.getSessionName?.() ||
			readFirstMessage(record.sessionFile) ||
			path.basename(record.cwd) ||
			"session";

		const entry: StoredMultiplexSession = {
			id: record.id !== PARENT_SESSION_ID ? record.id : `sess-${Date.now().toString(36)}`,
			sessionFile: record.sessionFile,
			cwd: record.cwd,
			name: realName,
			pinned: existingIdx >= 0 ? registry[existingIdx].pinned : false,
			createdAt: record.createdAt || (existingIdx >= 0 ? registry[existingIdx].createdAt : Date.now()),
			lastActivityAt: record.lastActivityAt || Date.now(),
		};
		if (existingIdx >= 0) {
			registry[existingIdx] = { ...registry[existingIdx], ...entry };
		} else {
			registry.unshift(entry);
		}
		saveMultiplexRegistry(registry);
	}

	bindSessionContext(ctx: CommandContext): LiveSessionRecord {
		const liveChild = [...this.records.values()].find(
			(r) => r.kind === "child" && r.mode === (ctx as any).mode,
		);
		if (liveChild) {
			liveChild.context = ctx;
			liveChild.cwd = ctx.cwd || liveChild.cwd;
			return liveChild;
		}
		this.registerParent(ctx);
		return this.records.get(PARENT_SESSION_ID)!;
	}

	updateActivity(ctx: CommandContext, activity: Activity, status?: string): void {
		const record = this.bindSessionContext(ctx);
		record.activity = activity;
		if (status !== undefined) record.status = status;
		record.lastActivityAt = Date.now();
		this.notify();
	}

	togglePin(idOrPath: string): void {
		const registry = loadMultiplexRegistry();
		const entry = registry.find((s) => s.id === idOrPath || s.sessionFile === idOrPath);
		if (entry) {
			entry.pinned = !entry.pinned;
			saveMultiplexRegistry(registry);
		}
		this.notify();
	}

	async renameSession(idOrPath: string, newName: string): Promise<void> {
		const trimmed = (newName || "").trim();
		if (!trimmed) return;
		const registry = loadMultiplexRegistry();
		const entry = registry.find((s) => s.id === idOrPath || s.sessionFile === idOrPath);
		if (entry) {
			entry.name = trimmed;
			saveMultiplexRegistry(registry);
		}
		const live = this.get(idOrPath);
		if (live) {
			live.name = trimmed;
			if (live.sessionFile && fs.existsSync(live.sessionFile)) {
				try {
					const sm = SessionManager.open(live.sessionFile);
					sm.appendSessionInfo(trimmed);
				} catch {}
			}
		} else if (fs.existsSync(idOrPath)) {
			try {
				const sm = SessionManager.open(idOrPath);
				sm.appendSessionInfo(trimmed);
			} catch {}
		}
		this.notify();
	}

	async removeMultiplexedSession(idOrPath: string): Promise<void> {
		const live = this.get(idOrPath);
		if (live && live.kind === "child") {
			await this.stopChild(live.id);
		}
		const registry = loadMultiplexRegistry();
		const filtered = registry.filter((s) => s.id !== idOrPath && s.sessionFile !== idOrPath);
		saveMultiplexRegistry(filtered);
		this.notify();
	}

	registerSessionFile(sessionFile: string, cwd: string, name?: string): void {
		const registry = loadMultiplexRegistry();
		if (registry.some((s) => s.sessionFile === sessionFile)) return;
		const realName =
			name ||
			readFirstMessage(sessionFile) ||
			path.basename(cwd) ||
			"session";
		registry.unshift({
			id: `sess-${Date.now().toString(36)}`,
			sessionFile,
			cwd,
			name: realName,
			pinned: false,
			createdAt: Date.now(),
			lastActivityAt: Date.now(),
		});
		saveMultiplexRegistry(registry);
	}

	async dispatchChildWithPrompt(
		ctx: CommandContext,
		promptText: string,
		cwd?: string,
	): Promise<LiveSessionRecord> {
		const targetCwd = cwd || ctx.cwd || process.cwd();
		const child = await this.createChildFromContext(ctx, targetCwd);
		child.activity = "working";
		child.transcript = promptText;
		this.persistSessionRecord(child);
		this.notify();

		try {
			child.runtime?.session?.subscribe?.((event: any) => {
				if (event.type === "agent_start" || event.type === "turn_start") {
					child.activity = "working";
					child.lastActivityAt = Date.now();
					this.notify();
				} else if (event.type === "agent_end") {
					child.activity = "idle";
					child.lastActivityAt = Date.now();
					this.notify();
				} else if (event.type === "tool_execution_start") {
					child.transcript = `Running ${event.toolName}...`;
					this.notify();
				}
			});
		} catch {}

		child.runPromise = (async () => {
			try {
				await child.runtime.session.prompt(promptText);
			} catch (err: any) {
				child.error = String(err?.message || err);
			} finally {
				child.activity = "idle";
				child.transcript = resolveTranscriptName(child.name, child.sessionFile) || promptText;
				this.persistSessionRecord(child);
				this.notify();
			}
		})();

		return child;
	}

	async listMultiplexedSessions(
		_orgMode: "state" | "directory",
		currentCwd: string,
	): Promise<any[]> {
		const parentRecord = this.records.get(PARENT_SESSION_ID);
		if (parentRecord?.sessionFile) {
			this.persistSessionRecord(parentRecord);
		}

		const currentRegistry = loadMultiplexRegistry();
		const result: any[] = [];
		const seenFiles = new Set<string>();
		const activeFile = this.getActiveSessionFile();

		for (const entry of currentRegistry) {
			if (!entry.sessionFile || seenFiles.has(entry.sessionFile)) continue;
			seenFiles.add(entry.sessionFile);

			const live = [...this.records.values()].find(
				(r) => r.sessionFile === entry.sessionFile,
			);

			const isCurrent = Boolean(activeFile && activeFile === entry.sessionFile);

			let state: "needs_input" | "working" | "completed" = "completed";
			let agentStatus = "idle";
			let summary = entry.name;

			if (live) {
				agentStatus = live.activity || "idle";
				if (live.activity === "working") {
					state = "working";
				} else if (isCurrent || live.activity === "waiting") {
					state = "needs_input";
				}
				summary = live.transcript || resolveTranscriptName(live.name, live.sessionFile) || entry.name;
			} else if (entry.sessionFile && fs.existsSync(entry.sessionFile)) {
				summary = readFirstMessage(entry.sessionFile) || entry.name;
			}

			result.push({
				id: live?.id || entry.id || entry.sessionFile,
				name: isCurrent ? "current session" : (entry.name || "session"),
				cwd: entry.cwd || currentCwd,
				branch: getGitBranch(entry.cwd || currentCwd),
				state,
				agentStatus,
				summary,
				modified: new Date(entry.lastActivityAt || entry.createdAt || Date.now()),
				isLive: Boolean(live),
				isCurrent,
				sessionFile: entry.sessionFile,
				pinned: Boolean(entry.pinned),
			});
		}

		return result;
	}

	async createChildFromContext(
		ctx: CommandContext,
		cwd: string,
	): Promise<LiveSessionRecord> {
		this.bindSessionContext(ctx);
		const sessionManager = SessionManager.create(cwd, undefined, {});
		return await this.createRecordForSessionManager({
			name: path.basename(cwd || process.cwd()) || "session",
			cwd,
			sessionManager,
			inheritance: safeCollectRuntimeInheritance(ctx),
		});
	}

	async openSavedSessionAsLive(
		sessionPath: string,
		cwdOverride?: string,
		ctx?: CommandContext,
	): Promise<LiveSessionRecord> {
		const existing = [...this.records.values()].find(
			(r) =>
				r.kind === "child" &&
				r.sessionFile === sessionPath &&
				!["stopped", "error"].includes(r.state),
		);
		if (existing) return existing;
		const sessionManager = SessionManager.open(
			sessionPath,
			undefined,
			cwdOverride,
		);
		const cwd = sessionManager.getCwd?.() || cwdOverride || process.cwd();
		const name = sanitizeName(
			sessionManager.getSessionName?.() ||
				path.basename(cwd) ||
				sessionManager.getSessionId?.(),
		);
		const child = await this.createRecordForSessionManager({
			name,
			cwd,
			sessionManager,
			inheritance: safeCollectRuntimeInheritance(ctx),
		});
		this.persistSessionRecord(child);
		return child;
	}

	private async createRecordForSessionManager(opts: {
		name: string;
		cwd: string;
		sessionManager: any;
		parent?: LiveSessionRecord;
		inheritance?: any;
	}): Promise<LiveSessionRecord> {
		const id = `${sanitizeName(opts.name)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
		const record: LiveSessionRecord = {
			id,
			kind: "child",
			name: sanitizeName(opts.name),
			cwd: opts.cwd,
			state: "starting",
			activity: "idle",
			sessionManager: opts.sessionManager,
			sessionFile: opts.sessionManager.getSessionFile?.(),
			sessionId: opts.sessionManager.getSessionId?.(),
			parentSessionFile: opts.parent?.sessionFile,
			parentLeafId: opts.parent?.sessionManager?.getLeafId?.() || null,
			createdAt: Date.now(),
			lastActivityAt: Date.now(),
			transcript: resolveTranscriptName(
				opts.sessionManager.getSessionName?.(),
				opts.sessionManager.getSessionFile?.(),
			),
			inheritance: opts.inheritance,
		};
		this.records.set(id, record);
		this.notify();
		if (opts.inheritance) {
			runtimeInheritanceBySessionManager.set(
				opts.sessionManager,
				opts.inheritance,
			);
		}
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: opts.cwd,
			agentDir: getAgentDir(),
			sessionManager: opts.sessionManager,
			sessionStartEvent: { type: "session_start", reason: "startup" } as any,
		});
		const mode = new InteractiveMode(runtime, {
			migratedProviders: [],
			modelFallbackMessage: runtime.modelFallbackMessage,
			initialMessage: undefined,
			initialImages: [],
			initialMessages: [],
		});
		record.runtime = runtime;
		record.mode = mode;
		record.adapter = new InteractiveModeAdapter(id, runtime, mode, this);
		record.state = "suspended";
		record.transcript = resolveTranscriptName(
			opts.sessionManager.getSessionName?.(),
			opts.sessionManager.getSessionFile?.(),
		);
		this.notify();
		return record;
	}

	async stopChild(nameOrId: string): Promise<void> {
		const record = this.get(nameOrId);
		if (!record || record.kind !== "child") return;
		const wasActive = this.activeId === record.id;
		record.expectedStop = true;
		record.state = "stopped";
		record.status = "stopped";
		this.locks.release(record.id);
		try {
			if (wasActive) record.adapter?.suspend();
			await record.adapter?.dispose();
		} catch {}
		this.records.delete(record.id);
		this.notify();
		if (wasActive) await this.activate(PARENT_SESSION_ID);
	}

	async activate(targetIdOrName: string): Promise<void> {
		const target = this.get(targetIdOrName);
		if (!target) throw new Error(`session not found: ${targetIdOrName}`);
		if (this.activationInProgress) {
			this.queuedActivation = target.id;
			await this.activationInProgress;
			return;
		}
		this.activationInProgress = this.doActivate(target).finally(() => {
			this.activationInProgress = null;
		});
		await this.activationInProgress;
		const queued = this.queuedActivation;
		this.queuedActivation = null;
		if (queued && queued !== this.activeId) await this.activate(queued);
	}

	private async doActivate(target: LiveSessionRecord): Promise<void> {
		if (target.id === this.activeId) return;
		const current = this.get(this.activeId);
		if (current?.kind === "child") current.adapter?.suspend();
		if (current?.kind === "parent") current.state = "suspended";

		if (target.kind === "parent") {
			this.activeId = PARENT_SESSION_ID;
			target.state = "active";
			try {
				this.parentTui?.terminal?.setProgress?.(false);
				this.parentTui?.start?.();
				this.parentTui?.requestRender?.(true);
			} catch {}
			const done = this.parentDone;
			this.parentTui = null;
			this.parentDone = null;
			this.parentHandoffActive = false;
			this.notify();
			done?.();
			return;
		}

		this.activeId = target.id;
		target.state = "active";
		if (!target.started) target.adapter?.start();
		else target.adapter?.resume();
		this.notify();
	}

	async enterFromParent(ctx: CommandContext, targetId: string): Promise<void> {
		if (this.parentHandoffActive) return this.activate(targetId);
		await ctx.ui.custom(
			(tui: any, _theme: any, _keybindings: any, done: () => void) => {
				this.parentTui = tui;
				this.parentDone = done;
				this.parentHandoffActive = true;
				try {
					tui.stop();
					resetExtendedKeyboardModesForHandoff();
				} catch {}
				void this.activate(targetId).catch((error) => {
					try {
						tui.start();
						tui.requestRender(true);
					} catch {}
					this.parentHandoffActive = false;
					this.parentTui = null;
					this.parentDone = null;
					ctx.ui.notify(String(error?.message || error), "error");
					done();
				});
				return { render: () => [], invalidate: () => {}, dispose: () => {} };
			},
		);
	}

	async activateFromContext(
		ctx: CommandContext,
		targetId: string,
	): Promise<void> {
		const current = this.records.get(PARENT_SESSION_ID);
		if (current?.id === this.activeId && targetId !== PARENT_SESSION_ID) {
			await this.enterFromParent(ctx, targetId);
		} else {
			await this.activate(targetId);
		}
	}
}

function getHost(): PiSessionsHost {
	const g = globalThis as any;
	if (!g[HOST_KEY]) g[HOST_KEY] = new PiSessionsHost();
	return g[HOST_KEY];
}

function patchInteractiveModeWorkingIndicator(host: PiSessionsHost): void {
	const proto = (InteractiveMode as any)?.prototype;
	if (
		!proto ||
		proto[INTERACTIVE_MODE_SPINNER_PATCHED] ||
		typeof proto.setWorkingIndicator !== "function"
	) {
		return;
	}
	const original = proto.setWorkingIndicator;
	proto.setWorkingIndicator = function (options?: WorkingIndicatorOptions) {
		const source = [...host.records.values()].find((record) => record.mode === this);
		const teardownReset =
			options === undefined &&
			source !== undefined &&
			(source.expectedStop === true ||
				source.state === "stopped" ||
				source.state === "error");
		if (!teardownReset) {
			host.workingIndicator = options;
			host.notify();
		}
		return original.call(this, options);
	};
	proto[INTERACTIVE_MODE_SPINNER_PATCHED] = true;
}

function installWidget(ctx: CommandContext, host: PiSessionsHost): void {
	ctx.ui.setWidget("pi-sessions", (tui: any, theme: any) => {
		const requestRender = () => tui.requestRender();
		const unsubscribe = host.subscribe(requestRender);
		const widget = new SessionWidget(
			theme,
			() => host.snapshot(),
			requestRender,
			() => host.workingIndicator,
		);
		return {
			render: (width: number) => {
				if (host.inAgentView) return [];
				return widget.render(width);
			},
			invalidate: () => widget.invalidate(),
			dispose: () => {
				unsubscribe();
				widget.dispose();
			},
		};
	});
}

async function openSessions(
	ctx: CommandContext,
	host: PiSessionsHost,
): Promise<void> {
	let targetToActivate: string | null = null;
	let targetToKill: string | null = null;

	host.inAgentView = true;
	host.notify();

	// Hide main Pi footer while in Agent View
	ctx.ui.setFooter?.(() => ({
		render: () => [],
		invalidate: () => {},
		dispose: () => {},
	}));

	try {
		await showSessionsView(ctx, {
			getSessions: async (orgMode: "state" | "directory") =>
				host.listMultiplexedSessions(orgMode, ctx.cwd || process.cwd()),
			getResumeSessions: async () => {
				const sessions = await SessionManager.listAll();
				return sessions.sort(
					(a: any, b: any) => Number(b.modified) - Number(a.modified),
				);
			},
			getAttached: () => host.activeId,
			getCwd: () => ctx.cwd || process.cwd(),
			switchTo: async (id: string) => {
				const target = host.get(id === "parent" ? PARENT_SESSION_ID : id);
				if (!target) {
					const child = await host.openSavedSessionAsLive(id, undefined, ctx);
					targetToActivate = child.id;
					return;
				}
				targetToActivate = target.id;
			},
			dispatchSession: async (prompt: string, cwd?: string) => {
				const child = await host.dispatchChildWithPrompt(
					ctx,
					prompt,
					cwd || ctx.cwd || process.cwd(),
				);
				return child.id;
			},
			retrieveSession: async (sessionPath: string) => {
				host.registerSessionFile(sessionPath, ctx.cwd || process.cwd());
				host.notify();
			},
			resumeSession: async (sessionPath: string) => {
				const child = await host.openSavedSessionAsLive(
					sessionPath,
					undefined,
					ctx,
				);
				targetToActivate = child.id;
				return child.id;
			},
			renameSession: async (idOrPath: string, newName: string) => {
				await host.renameSession(idOrPath, newName);
			},
			togglePinSession: (idOrPath: string) => {
				host.togglePin(idOrPath);
			},
			removeSession: async (idOrPath: string) => {
				await host.removeMultiplexedSession(idOrPath);
			},
			killSession: async (id: string) => {
				targetToKill = id;
			},
			notify: (message: string, type?: "info" | "warning" | "error") =>
				ctx.ui.notify(message, type || "info"),
		});
	} finally {
		host.inAgentView = false;
		host.notify();
		// Restore Pi's default footer on exit
		ctx.ui.setFooter?.(undefined);
	}

	if (targetToKill) {
		await host.stopChild(targetToKill);
		return;
	}
	if (!targetToActivate || targetToActivate === host.activeId) return;
	await host.activateFromContext(ctx, targetToActivate);
}

export default function (pi: ExtensionAPI) {
	const host = getHost();
	patchInteractiveModeWorkingIndicator(host);

	let activeUiPromptCount = 0;

	pi.registerCommand("sessions", {
		description: "Open the pi-sessions switcher",
		handler: async (_args: string, ctx: CommandContext) =>
			openSessions(ctx, host),
	});

	// Track blocking extension prompts (e.g. Guardrails)
	pi.on("ui_prompt_start", (event: any, ctx: CommandContext) => {
		activeUiPromptCount++;
		host.updateActivity(ctx, "waiting", event?.title || "Waiting for input");
	});

	pi.on("ui_prompt_end", (_event: any, ctx: CommandContext) => {
		activeUiPromptCount = Math.max(0, activeUiPromptCount - 1);
		host.updateActivity(ctx, "idle");
	});

	pi.on("session_start", async (event: any, ctx: CommandContext) => {
		if (event?.previousSessionFile) {
			host.registerSessionFile(
				event.previousSessionFile,
				ctx.cwd || process.cwd(),
			);
		}
		if (ctx.mode !== "tui") return;
		host.bindSessionContext(ctx);
		installWidget(ctx, host);

		ctx.ui.onTerminalInput?.((data: string) => {
			if (data === "\x1b[D") { // Left Arrow
				try {
					// 1. Never activate if an extension prompt/dialog is open
					if (activeUiPromptCount > 0) return;

					// 2. Check if current InteractiveMode has a built-in or extension selector open
					const currentRecord = host.get(host.activeId || PARENT_SESSION_ID);
					const mode = currentRecord?.mode;
					if (mode) {
						if (mode.activeSelectorToken !== undefined) return;
						if (mode.extensionSelector || mode.extensionInput || mode.extensionEditor) return;
						const focused = mode.renderer?.getFocusedComponent?.();
						if (focused && focused !== mode.editor && focused !== mode.defaultEditor) return;
					}

					// 3. Only activate when prompt is completely empty
					if (!ctx.ui.getEditorText().trim()) {
						void openSessions(ctx, host);
					}
				} catch {}
			}
		});
	});

	pi.registerShortcut("ctrl+r", {
		description: "Open sessions switcher",
		handler: async (ctx: CommandContext) => openSessions(ctx, host),
	});

	pi.on("agent_start", (_event: any, ctx: CommandContext) => {
		host.updateActivity(ctx, "working");
	});

	pi.on("agent_end", (_event: any, ctx: CommandContext) => {
		host.updateActivity(ctx, "idle");
	});

	pi.on("tool_call", async (event: any, ctx: CommandContext) => {
		const record = host.bindSessionContext(ctx);
		const reason = needsPermission(event.toolName, event.input, record.name);
		if (reason) {
			if (record.id !== host.activeId) host.updateActivity(ctx, "waiting");
			const ok = await ctx.ui.confirm("pi-sessions permission", reason, {
				timeout: 60000,
			} as any);
			if (ok && record.id !== host.activeId) {
				record.activity = "working";
				record.lastActivityAt = Date.now();
				host.notify();
			}
			if (!ok)
				return {
					block: true,
					reason: "Denied by pi-sessions permission routing",
				};
		}
		if (["edit", "write"].includes(event.toolName) && event.input?.path) {
			const lock = host.locks.acquire(record.id, [event.input.path]);
			if (!lock.ok) {
				return {
					block: true,
					reason: `Path conflict: ${lock.conflict} locked by another session`,
				};
			}
		}
	});

	pi.on("tool_execution_end", (event: any, ctx: CommandContext) => {
		const record = host.bindSessionContext(ctx);
		if (["edit", "write"].includes(event.toolName) && event.input?.path) {
			host.locks.release(record.id, [event.input.path]);
		}
	});
}
