const { createJiti } = require("/Users/oscarliswei/.n/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti");
const jiti = createJiti(process.cwd());
const ui = jiti("./ui.ts");

// Mock Theme
const mockTheme = {
	bold: (s) => `\x1b[1m${s}\x1b[22m`,
	fg: (color, s) => s,
	bg: (color, s) => s,
};

let renamed = null;
let pinned = null;
let switched = null;

// Mock Actions
const mockActions = {
	getSessions: async (scope) => {
		return [
			{
				id: "sess-1",
				name: "current session",
				cwd: "/Users/oscarliswei/Projects/pi-sessions",
				branch: "main",
				state: "needs_input",
				summary: "Refactoring the session viewer",
				modified: new Date(Date.now() - 14000),
				isLive: true,
				isCurrent: true,
				pinned: pinned === "sess-1",
			},
			{
				id: "sess-2",
				name: renamed || "General assistance",
				cwd: "/Users/oscarliswei/Projects/pi-sessions",
				branch: "main",
				state: "completed",
				summary: "Updated memory/use-jj-vcs.md and MEMORY.md",
				modified: new Date(Date.now() - 16000),
				isLive: false,
				isCurrent: false,
			},
		];
	},
	getDefaultScope: () => "current",
	getAttached: () => "sess-1",
	getCwd: () => "/Users/oscarliswei/Projects/pi-sessions",
	switchTo: async (id) => {
		switched = id;
	},
	dispatchSession: async (prompt) => {
		return "sess-new";
	},
	resumeSession: async (path) => {
		switched = path;
	},
	renameSession: async (id, name) => {
		renamed = name;
	},
	togglePinSession: (id) => {
		pinned = pinned === id ? null : id;
	},
	killSession: async (id) => {},
	notify: (msg, type) => {},
};

(async () => {
	let capturedView = null;
	const mockCtx = {
		ui: {
			custom: async (factory) => {
				capturedView = factory(
					{ requestRender: () => {} },
					mockTheme,
					{},
					() => {},
				);
			},
		},
	};

	await ui.showSessionsView(mockCtx, mockActions);
	await new Promise((r) => setTimeout(r, 50));

	console.log("=== Testing Pinning (Ctrl+T) ===");
	capturedView.handleInput("\x14"); // Ctrl+T
	await new Promise((r) => setTimeout(r, 50));
	const pinnedLines = capturedView.render(100);
	if (!pinnedLines.join("\n").includes("📌")) {
		throw new Error("Pin marker not found after Ctrl+T");
	}
	console.log("[PASS] Ctrl+T successfully toggled pin marker.");

	console.log("=== Testing Quick Open (Alt+1) ===");
	capturedView.handleInput("\x1b1"); // Alt+1
	if (switched !== "sess-1") {
		throw new Error(`Expected switched to be 'sess-1', got '${switched}'`);
	}
	console.log("[PASS] Alt+1 successfully switched to session #1.");

	console.log("=== Testing Inline Rename (Ctrl+R) ===");
	// Move down to sess-2
	capturedView.handleInput("\x1b[B"); // Down arrow
	capturedView.handleInput("\x12"); // Ctrl+R
	const renameLines = capturedView.render(100);
	if (!renameLines.join("\n").includes("Rename:")) {
		throw new Error("Rename bar not displayed after Ctrl+R");
	}
	// Enter new name and press enter
	capturedView.handleInput("NewTaskName");
	capturedView.handleInput("\r");
	await new Promise((r) => setTimeout(r, 50));
	if (renamed !== "General assistanceNewTaskName") {
		throw new Error(`Expected renamed name to be updated, got '${renamed}'`);
	}
	console.log("[PASS] Ctrl+R inline rename completed successfully.");

	capturedView.dispose();
	console.log("=== ALL KEYBOARD SHORTCUTS VALIDATED! ===");
	process.exit(0);
})();
