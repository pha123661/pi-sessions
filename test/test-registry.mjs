import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testRegistryPath = path.join(os.tmpdir(), "test-multiplexed-sessions.json");

function loadTestRegistry() {
	try {
		if (fs.existsSync(testRegistryPath)) {
			return JSON.parse(fs.readFileSync(testRegistryPath, "utf8")).sessions || [];
		}
	} catch {}
	return [];
}

function saveTestRegistry(sessions) {
	fs.writeFileSync(testRegistryPath, JSON.stringify({ sessions }, null, 2));
}

// Test saving and loading
saveTestRegistry([
	{
		id: "sess-1",
		sessionFile: "/path/to/sess-1.jsonl",
		cwd: "/Users/test/project",
		name: "Test Session",
		pinned: true,
		createdAt: Date.now(),
		lastActivityAt: Date.now(),
	},
]);

const loaded = loadTestRegistry();
assert.strictEqual(loaded.length, 1);
assert.strictEqual(loaded[0].name, "Test Session");
assert.strictEqual(loaded[0].pinned, true);

fs.unlinkSync(testRegistryPath);
console.log("[PASS] Multiplexed sessions persistence test passed.");
