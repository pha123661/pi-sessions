const { createJiti } = require("/Users/oscarliswei/.n/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti");
const jiti = createJiti(process.cwd());
const ui = jiti("./ui.ts");
const { visibleWidth } = require("@earendil-works/pi-tui");

const mockTheme = {
	bold: (s) => `\x1b[1m${s}\x1b[22m`,
	fg: (color, s) => s,
	bg: (color, s) => s,
};

async function main() {
	let capturedView = null;
	const mockCtx = {
		ui: {
			theme: {
				bold: (s) => `\x1b[1m${s}\x1b[22m`,
				fg: (color, s) => s,
				bg: (color, s) => s,
			},
			custom: async (factory) => {
				capturedView = factory(
					{
						requestRender: () => {},
					},
					mockTheme,
					{},
					() => {},
				);
				return Promise.resolve();
			},
		},
	};

	const mockSessions = [
		{
			id: "sess-1",
			name: "current session",
			cwd: "/Users/test/project",
			branch: "main",
			state: "needs_input",
			agentStatus: "idle",
			summary: "how do I update the sessions UI to mimic claude code behavior? give me plans and proposals",
			modified: new Date(),
			isLive: true,
			isCurrent: true,
			sessionFile: "/tmp/s1.jsonl",
			pinned: false,
		},
		{
			id: "sess-2",
			name: "Completed Task",
			cwd: "/Users/test/project",
			branch: "main",
			state: "completed",
			agentStatus: "idle",
			summary: "Finished job",
			modified: new Date(),
			isLive: false,
			isCurrent: false,
			sessionFile: "/tmp/s2.jsonl",
			pinned: false,
		},
	];

	const mockActions = {
		getSessions: async () => mockSessions,
		getResumeSessions: async () => [],
		getAttached: () => "sess-1",
		getCwd: () => "/Users/test/project",
		switchTo: async () => {},
		retrieveSession: async () => {},
		resumeSession: async () => {},
		killSession: async () => {},
		notify: () => {},
	};

	await ui.showSessionsView(mockCtx, mockActions);
	await new Promise((r) => setTimeout(r, 60));

	console.log("Testing visibleWidth <= width across terminal widths 20 to 220 in ALL states:");
	
	for (let w = 20; w <= 220; w++) {
		// 1. Normal state with empty prompt
		const linesEmpty = capturedView.render(w);
		for (let i = 0; i < linesEmpty.length; i++) {
			const vw = visibleWidth(linesEmpty[i]);
			if (vw > w) {
				throw new Error(`[EMPTY] Line ${i} exceeds width at terminal width ${w}: visibleWidth=${vw} > ${w}\nLine content: "${linesEmpty[i]}"`);
			}
		}

		// 2. State with typed task text
		capturedView.taskInput.setValue("A very long task description that might cause line wrapping or overflow in some cases " + "x".repeat(100));
		const linesTyped = capturedView.render(w);
		for (let i = 0; i < linesTyped.length; i++) {
			const vw = visibleWidth(linesTyped[i]);
			if (vw > w) {
				throw new Error(`[TYPED] Line ${i} exceeds width at terminal width ${w}: visibleWidth=${vw} > ${w}\nLine content: "${linesTyped[i]}"`);
			}
		}

		// 3. State with expanded shortcuts
		capturedView.showShortcuts = true;
		const linesExpanded = capturedView.render(w);
		for (let i = 0; i < linesExpanded.length; i++) {
			const vw = visibleWidth(linesExpanded[i]);
			if (vw > w) {
				throw new Error(`[EXPANDED] Line ${i} exceeds width at terminal width ${w}: visibleWidth=${vw} > ${w}\nLine content: "${linesExpanded[i]}"`);
			}
		}
		capturedView.showShortcuts = false;

		// 4. State with inline notice
		capturedView.notify("Cannot remove current foreground session.", "warning");
		const linesNotice = capturedView.render(w);
		for (let i = 0; i < linesNotice.length; i++) {
			const vw = visibleWidth(linesNotice[i]);
			if (vw > w) {
				throw new Error(`[NOTICE] Line ${i} exceeds width at terminal width ${w}: visibleWidth=${vw} > ${w}\nLine content: "${linesNotice[i]}"`);
			}
		}

		capturedView.taskInput.setValue("");
	}

	capturedView.dispose();
	console.log("[PASS] Strict width boundary check passed for ALL widths 20 to 220 across ALL states!");
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
