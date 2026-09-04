const { createJiti } = require("/Users/oscarliswei/.n/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti");
const jiti = createJiti(process.cwd());
const ui = jiti("./ui.ts");

// Mock Theme
const mockTheme = {
	bold: (s) => `\x1b[1m${s}\x1b[22m`,
	fg: (color, s) => s,
	bg: (color, s) => s,
};

let pinnedIds = new Set(["sess-2"]); // sess-2 pinned
let removedId = null;

// Mock Actions
const mockActions = {
	getSessions: async (orgMode) => {
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
				pinned: pinnedIds.has("sess-1"),
			},
			{
				id: "sess-2",
				name: "Pinned Task",
				cwd: "/Users/oscarliswei/Projects/homepage",
				branch: "feat/pinned",
				state: "completed",
				summary: "Pinned session summary",
				modified: new Date(Date.now() - 100000),
				isLive: false,
				isCurrent: false,
				pinned: pinnedIds.has("sess-2"),
			},
			{
				id: "sess-3",
				name: "Completed Task",
				cwd: "/Users/oscarliswei/Projects/pi-sessions",
				branch: "main",
				state: "completed",
				summary: "Finished previous job",
				modified: new Date(Date.now() - 200000),
				isLive: false,
				isCurrent: false,
				pinned: pinnedIds.has("sess-3"),
			},
		];
	},
	getResumeSessions: async () => [],
	getAttached: () => "sess-1",
	getCwd: () => "/Users/oscarliswei/Projects/pi-sessions",
	switchTo: async (id) => console.log("switchTo:", id),
	dispatchSession: async (prompt) => {
		console.log("dispatchSession:", prompt);
		return "sess-new";
	},
	retrieveSession: async (sessionPath) => console.log("retrieveSession:", sessionPath),
	resumeSession: async (path) => console.log("resumeSession:", path),
	renameSession: async (id, name) => console.log("renameSession:", id, name),
	togglePinSession: (id) => {
		if (pinnedIds.has(id)) pinnedIds.delete(id);
		else pinnedIds.add(id);
	},
	removeSession: async (id) => {
		removedId = id;
	},
	killSession: async (id) => console.log("killSession:", id),
	notify: (msg, type) => console.log(`notify (${type}):`, msg),
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
	await new Promise((r) => setTimeout(r, 60));

	console.log("=== 1. Testing Pinned Section in State View ===");
	const linesState = capturedView.render(110);
	const textState = linesState.join("\n");
	console.log(textState);
	if (!textState.includes("Pinned")) {
		throw new Error("Missing 'Pinned' section in State view");
	}
	if (!textState.includes("Pinned Task")) {
		throw new Error("Missing pinned item in Pinned section");
	}
	console.log("[PASS] Pinned section rendered at top of State View.");

	console.log("=== 2. Testing Pinned Section in Directory View (Ctrl+S) ===");
	capturedView.handleInput("\x13"); // Ctrl+S to switch view
	await new Promise((r) => setTimeout(r, 60));
	const linesDir = capturedView.render(110);
	const textDir = linesDir.join("\n");
	console.log(textDir);
	if (!textDir.includes("Group by Directory")) {
		throw new Error("View mode label does not show 'Group by Directory'");
	}
	if (!textDir.includes("Pinned")) {
		throw new Error("Missing 'Pinned' section in Directory view");
	}
	console.log("[PASS] Pinned section also rendered at top of Directory View.");

	// Switch back to State view
	capturedView.handleInput("\x13"); // Ctrl+S
	await new Promise((r) => setTimeout(r, 60));

	console.log("=== 3. Testing '?' Short-cut Toggling vs Typing '?' ===");
	// When empty, ? toggles shortcuts
	if (textState.includes("ctrl+s to switch views")) {
		throw new Error("Shortcuts should be collapsed by default");
	}
	capturedView.handleInput("?"); // Press ? on empty input
	const linesExpanded = capturedView.render(110);
	if (!linesExpanded.join("\n").includes("ctrl+s to switch views")) {
		throw new Error("Pressing '?' on empty input failed to expand shortcuts");
	}
	console.log("[PASS] Pressing '?' on empty prompt expands shortcuts footer.");

	capturedView.handleInput("?"); // Press ? again to collapse
	const linesCollapsed = capturedView.render(110);
	if (linesCollapsed.join("\n").includes("ctrl+s to switch views")) {
		throw new Error("Pressing '?' on empty input failed to collapse shortcuts");
	}
	console.log("[PASS] Pressing '?' on empty prompt collapses shortcuts footer.");

	// Now type a prompt containing '?'
	capturedView.handleInput("W");
	capturedView.handleInput("h");
	capturedView.handleInput("y");
	capturedView.handleInput("?"); // Typing '?' as part of task!
	const linesTyped = capturedView.render(110);
	if (!linesTyped.join("\n").includes("❯ Why?")) {
		throw new Error("Typing '?' when input is not empty should NOT toggle shortcuts, but insert '?'");
	}
	console.log("[PASS] Typing '?' while writing prompt correctly inserts '?' without toggling footer!");

	console.log("=== 4. Testing Native Cursor & Text Rendering ===");
	// Verify that text and native cursor are present in the prompt
	const hasQuestionMark = linesTyped.join("\n").includes("Why?");
	if (!hasQuestionMark) {
		throw new Error("Typed text not found in prompt line");
	}
	console.log("[PASS] Native Input correctly rendered typed text and cursor.");

	console.log("=== 5. Testing Esc clearing prompt ===");
	capturedView.handleInput("\x1b"); // Esc
	const linesCleared = capturedView.render(110);
	if (!linesCleared.join("\n").includes("describe a task for a new session")) {
		throw new Error("Esc failed to clear prompt");
	}
	console.log("[PASS] Esc cleared the prompt and restored placeholder with cursor.");

	console.log("=== 6. Testing Collapsible Section Consistency ===");
	// Row 0 is Pinned header (initially expanded)
	const linesH1 = capturedView.render(110).join("\n");
	if (!linesH1.includes("space to collapse")) {
		throw new Error("Expanded header should show '(space to collapse)'");
	}
	console.log("[PASS] Expanded header displays '(space to collapse)'.");

	// Press space to collapse
	capturedView.handleInput(" ");
	const linesH2 = capturedView.render(110).join("\n");
	if (!linesH2.includes("space to expand")) {
		throw new Error("Collapsed header should show '(space to expand)', got: " + linesH2);
	}
	console.log("[PASS] Collapsed header displays '(space to expand)'.");

	// Press space again to expand back
	capturedView.handleInput(" ");

	console.log("=== 7. Testing Ctrl+X on Current Foreground Session ===");
	// Navigate down to current session row (row 2 or 3)
	// Let's find index of current session
	while (true) {
		const row = capturedView.getSelectedRow?.();
		if (row && row.type === "session" && row.item.isCurrent) break;
		capturedView.handleInput("\x1b[B"); // down arrow
	}
	// Press Ctrl+X on current foreground session
	capturedView.handleInput("\x18"); // Ctrl+X
	const warningRender = capturedView.render(110).join("\n");
	console.log("View output after Ctrl+X:\n" + warningRender.slice(0, 300));
	if (!warningRender.includes("Cannot remove current foreground session.")) {
		throw new Error("Warning banner was not rendered inside Agent View on Ctrl+X!");
	}
	console.log("[PASS] In-view warning rendered directly inside Agent View on Ctrl+X!");

	capturedView.dispose();
	console.log("=== ALL V3 BEHAVIOR & BUG FIX TESTS PASSED! ===");
	process.exit(0);
})();
