import assert from "node:assert";

// Simulate the registry keyed by sessionFile
const registry = [
	{
		sessionFile: "/path/to/session-A.jsonl",
		cwd: "/Users/test/project",
		name: "Initial Task",
		pinned: false,
		lastActivityAt: 1000,
	},
];

let activeSessionFile = "/path/to/session-A.jsonl";

function onSessionStart(event, newSessionFile) {
	if (event.previousSessionFile) {
		// Ensure previous session file is kept in registry
		const prev = registry.find((s) => s.sessionFile === event.previousSessionFile);
		if (!prev) {
			registry.push({
				sessionFile: event.previousSessionFile,
				cwd: "/Users/test/project",
				name: "Previous Session",
				lastActivityAt: Date.now(),
			});
		}
	}
	activeSessionFile = newSessionFile;
	// Add or update new session file in registry
	const cur = registry.find((s) => s.sessionFile === newSessionFile);
	if (!cur) {
		registry.unshift({
			sessionFile: newSessionFile,
			cwd: "/Users/test/project",
			name: "New Retrieved Session",
			lastActivityAt: Date.now(),
		});
	}
}

// User runs /resume to switch to session-B
onSessionStart({ reason: "resume", previousSessionFile: "/path/to/session-A.jsonl" }, "/path/to/session-B.jsonl");

assert.strictEqual(registry.length, 2);
assert.strictEqual(registry[0].sessionFile, "/path/to/session-B.jsonl");
assert.strictEqual(registry[1].sessionFile, "/path/to/session-A.jsonl");
assert.strictEqual(activeSessionFile, "/path/to/session-B.jsonl");

console.log("[PASS] Session switching test: both Session A and Session B are preserved distinctly!");
