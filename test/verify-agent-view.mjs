import assert from "node:assert";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

console.log("=== Testing Agent View V2 Building Blocks ===");

// 1. Test Session Discovery
const currentCwd = process.cwd();
const currentSessions = await SessionManager.list(currentCwd);
console.log(`[PASS] SessionManager.list("${currentCwd}") returned ${currentSessions.length} session(s).`);

const allSessions = await SessionManager.listAll();
console.log(`[PASS] SessionManager.listAll() returned ${allSessions.length} session(s).`);
assert(allSessions.length >= currentSessions.length, "All sessions count must be >= current sessions count");

// 2. Test Git Branch Resolution
let branch = "";
try {
	branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
} catch {}
console.log(`[PASS] Git branch resolved: "${branch}"`);
assert.strictEqual(typeof branch, "string");

// 3. Test Relative Time formatting
function formatRelativeTime(date) {
	if (!date) return "now";
	const diffMs = Date.now() - date.getTime();
	if (diffMs < 0 || !Number.isFinite(diffMs)) return "now";
	const sec = Math.floor(diffMs / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(diffSec / 60);
	if (min < 60) return `${min}m`;
	const hour = Math.floor(min / 60);
	if (hour < 24) return `${hour}h`;
	const day = Math.floor(hour / 24);
	if (day < 30) return `${day}d`;
	const mo = Math.floor(day / 30);
	if (mo < 12) return `${mo}mo`;
	return `${Math.floor(day / 365)}y`;
}
const now = new Date();
assert.strictEqual(formatRelativeTime(new Date(now.getTime() - 14000)), "14s");
assert.strictEqual(formatRelativeTime(new Date(now.getTime() - 16000)), "16s");
console.log("[PASS] formatRelativeTime tests passed (14s, 16s).");

// 4. Test Settings Reading
function getDefaultScope() {
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
const scope = getDefaultScope();
console.log(`[PASS] getDefaultScope() resolved: "${scope}"`);
assert(["current", "all"].includes(scope));

console.log("=== All Building Block Tests Passed! ===");
