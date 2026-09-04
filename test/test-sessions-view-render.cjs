const { createJiti } = require("/Users/oscarliswei/.n/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti");
const jiti = createJiti(process.cwd());
const ui = jiti("./ui.ts");

// Mock Theme
const mockTheme = {
	bold: (s) => `\x1b[1m${s}\x1b[22m`,
	fg: (color, s) => s,
	bg: (color, s) => s,
};

// Mock Actions
const mockActions = {
	getSessions: async (scope) => {
		if (scope === "current") {
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
				},
				{
					id: "sess-2",
					name: "General assistance",
					cwd: "/Users/oscarliswei/Projects/pi-sessions",
					branch: "main",
					state: "completed",
					summary: "Updated memory/use-jj-vcs.md and MEMORY.md",
					modified: new Date(Date.now() - 16000),
					isLive: false,
					isCurrent: false,
				},
			];
		}
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
			},
			{
				id: "sess-3",
				name: "homepage-auth",
				cwd: "/Users/oscarliswei/Projects/homepage",
				branch: "feat/auth",
				state: "completed",
				summary: "Fix OAuth callback redirect loop",
				modified: new Date(Date.now() - 3600000),
				isLive: false,
				isCurrent: false,
			},
		];
	},
	getDefaultScope: () => "current",
	getAttached: () => "sess-1",
	getCwd: () => "/Users/oscarliswei/Projects/pi-sessions",
	switchTo: async (id) => console.log("switchTo:", id),
	dispatchSession: async (prompt) => {
		console.log("dispatchSession:", prompt);
		return "sess-new";
	},
	resumeSession: async (path) => console.log("resumeSession:", path),
	renameSession: async (id, name) => console.log("renameSession:", id, name),
	togglePinSession: (id) => console.log("togglePinSession:", id),
	killSession: async (id) => console.log("killSession:", id),
	notify: (msg, type) => console.log("notify:", type, msg),
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
					() => console.log("done() called"),
				);
			},
		},
	};

	await ui.showSessionsView(mockCtx, mockActions);

	// Wait a bit for initial refresh
	await new Promise((r) => setTimeout(r, 100));

	console.log("=== RENDERED AGENT VIEW OUTPUT (Width: 110) ===");
	const lines = capturedView.render(110);
	console.log(lines.join("\n"));
	console.log("================================================");

	// Assertions on the rendered output
	const renderedText = lines.join("\n");
	if (!renderedText.includes("Your conversation moved to the background")) {
		throw new Error("Missing top banner");
	}
	if (!renderedText.includes("Needs input")) {
		throw new Error("Missing 'Needs input' section");
	}
	if (!renderedText.includes("current session")) {
		throw new Error("Missing 'current session'");
	}
	if (!renderedText.includes("Completed")) {
		throw new Error("Missing 'Completed' section");
	}
	if (!renderedText.includes("describe a task for a new session")) {
		throw new Error("Missing prompt bar placeholder");
	}
	if (!renderedText.includes("ctrl+r to rename")) {
		throw new Error("Missing footer shortcuts");
	}
	if (!renderedText.includes("14s")) {
		throw new Error("Missing relative timestamp '14s'");
	}

	console.log("=== Testing Key Inputs ===");
	// 1. Test space for peek
	capturedView.handleInput(" ");
	const peekLines = capturedView.render(110);
	if (!peekLines.join("\n").includes("Peek: current session")) {
		throw new Error("Peek panel failed to open on Space");
	}
	console.log("[PASS] Space opened Peek panel.");

	// Close peek
	capturedView.handleInput("\x1b"); // Esc
	const closedPeekLines = capturedView.render(110);
	if (closedPeekLines.join("\n").includes("Peek: current session")) {
		throw new Error("Peek panel failed to close on Esc");
	}
	console.log("[PASS] Esc closed Peek panel.");

	// 2. Test typing task into input
	capturedView.handleInput("h");
	capturedView.handleInput("i");
	const typedLines = capturedView.render(110);
	if (!typedLines.join("\n").includes("❯ hi")) {
		throw new Error("Typing failed to display in prompt");
	}
	console.log("[PASS] Typing displayed in prompt bar (not search).");

	// 3. Test Enter to dispatch
	capturedView.handleInput("\r");
	const dispatchedLines = capturedView.render(110);
	if (!dispatchedLines.join("\n").includes("describe a task for a new session")) {
		throw new Error("Input was not cleared after dispatch");
	}
	console.log("[PASS] Enter dispatched task and cleared prompt.");

	// 4. Test Ctrl+S to switch views
	capturedView.handleInput("\x13"); // Ctrl+S
	await new Promise((r) => setTimeout(r, 100));
	const switchedLines = capturedView.render(110);
	if (!switchedLines.join("\n").includes("All folders")) {
		throw new Error("Ctrl+S failed to toggle to All folders");
	}
	console.log("[PASS] Ctrl+S switched view to All folders.");

	console.log("=== All Tests & Assertions Passed Successfully! ===");
	capturedView.dispose();
	process.exit(0);
})();
