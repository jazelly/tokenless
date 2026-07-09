import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const source = path.join(repoRoot, 'skills', 'tokenless');
const home = os.homedir();
const skillRoots = [
    path.join(home, '.codex'),
    path.join(home, '.agent'),
    path.join(home, '.agents'),
    path.join(home, '.claude'),
];
await assertSkillSource(source);
const synced = [];
const skipped = [];
for (const root of skillRoots) {
    if (!await exists(root)) {
        skipped.push(root);
        continue;
    }
    const destination = path.join(root, 'skills', 'tokenless');
    await fs.rm(destination, { recursive: true, force: true });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(source, destination, { recursive: true });
    synced.push(destination);
}
if (synced.length === 0) {
    throw new Error(`No known skill roots exist. Checked: ${skillRoots.join(', ')}`);
}
console.log(JSON.stringify({ synced, skipped }, null, 2));
async function assertSkillSource(skillPath) {
    const stat = await fs.stat(skillPath).catch(() => null);
    if (!stat?.isDirectory()) {
        throw new Error(`Skill source directory does not exist: ${skillPath}`);
    }
    const manifest = path.join(skillPath, 'SKILL.md');
    const manifestStat = await fs.stat(manifest).catch(() => null);
    if (!manifestStat?.isFile()) {
        throw new Error(`Skill source is missing SKILL.md: ${manifest}`);
    }
}
async function exists(targetPath) {
    return fs.access(targetPath).then(() => true, () => false);
}
//# sourceMappingURL=sync-tokenless-skill.mjs.map