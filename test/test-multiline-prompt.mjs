import assert from "node:assert";

class MultilinePrompt {
	lines = [""];
	cursorRow = 0;
	cursorCol = 0;

	getValue() {
		return this.lines.join("\n");
	}

	setValue(text) {
		this.lines = text ? text.split("\n") : [""];
		this.cursorRow = this.lines.length - 1;
		this.cursorCol = this.lines[this.cursorRow].length;
	}

	clear() {
		this.lines = [""];
		this.cursorRow = 0;
		this.cursorCol = 0;
	}

	handleInput(data) {
		// Newline insertion: Ctrl+J or \n
		if (data === "\n" || data === "\x0a") {
			const curLine = this.lines[this.cursorRow] ?? "";
			const before = curLine.slice(0, this.cursorCol);
			const after = curLine.slice(this.cursorCol);
			this.lines[this.cursorRow] = before;
			this.lines.splice(this.cursorRow + 1, 0, after);
			this.cursorRow++;
			this.cursorCol = 0;
			return;
		}

		// Backspace
		if (data === "\x7f" || data === "\x08") {
			const curLine = this.lines[this.cursorRow] ?? "";
			if (this.cursorCol > 0) {
				this.lines[this.cursorRow] = curLine.slice(0, this.cursorCol - 1) + curLine.slice(this.cursorCol);
				this.cursorCol--;
			} else if (this.cursorRow > 0) {
				const prevLine = this.lines[this.cursorRow - 1];
				this.cursorCol = prevLine.length;
				this.lines[this.cursorRow - 1] = prevLine + curLine;
				this.lines.splice(this.cursorRow, 1);
				this.cursorRow--;
			}
			return;
		}

		// Left arrow
		if (data === "\x1b[D") {
			if (this.cursorCol > 0) {
				this.cursorCol--;
			} else if (this.cursorRow > 0) {
				this.cursorRow--;
				this.cursorCol = this.lines[this.cursorRow].length;
			}
			return;
		}

		// Right arrow
		if (data === "\x1b[C") {
			const curLine = this.lines[this.cursorRow] ?? "";
			if (this.cursorCol < curLine.length) {
				this.cursorCol++;
			} else if (this.cursorRow < this.lines.length - 1) {
				this.cursorRow++;
				this.cursorCol = 0;
			}
			return;
		}

		// Ignore other escape sequences
		if (data.startsWith("\x1b")) return;

		// Regular text insertion
		const curLine = this.lines[this.cursorRow] ?? "";
		const before = curLine.slice(0, this.cursorCol);
		const after = curLine.slice(this.cursorCol);
		this.lines[this.cursorRow] = before + data + after;
		this.cursorCol += data.length;
	}

	render(width) {
		if (this.lines.length === 1 && !this.lines[0]) {
			return ["❯ describe a task for a new session"];
		}
		return this.lines.map((line, idx) => {
			const prefix = idx === 0 ? "❯ " : "  ";
			return (prefix + line).slice(0, width);
		});
	}
}

const prompt = new MultilinePrompt();
prompt.handleInput("First line");
assert.strictEqual(prompt.getValue(), "First line");

prompt.handleInput("\x0a"); // Ctrl+J
prompt.handleInput("Second line");
assert.strictEqual(prompt.getValue(), "First line\nSecond line");

console.log("[PASS] MultilinePrompt with Ctrl+J test passed!");
const rendered = prompt.render(80);
console.log("Rendered:\n" + rendered.join("\n"));
