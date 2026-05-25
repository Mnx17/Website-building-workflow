import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const outDir = join(root, ".generated");
const templatePath = join(root, "prompts", "website-build-prompt.md");
const outPath = join(outDir, "claude-build-prompt.md");

if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

const prompt = readFileSync(templatePath, "utf8");
const stamped = `# Generated ${new Date().toISOString()}\n\n${prompt}`;
writeFileSync(outPath, stamped, "utf8");

console.log("One-command workflow initialized.");
console.log(`Prompt written to: ${outPath}`);
console.log("");
console.log("Next step:");
console.log("Use your coding agent to execute the prompt in .generated/claude-build-prompt.md");

