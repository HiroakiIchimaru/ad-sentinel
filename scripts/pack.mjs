// dist/ を Chrome ウェブストア提出用の ZIP に固める(npm run pack)
import { readFile, readdir, rm, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = `${root}dist`;

try {
  await access(dist);
} catch {
  console.error("dist/ がありません。先に npm run build を実行してください。");
  process.exit(1);
}

const manifest = JSON.parse(await readFile(`${dist}/manifest.json`, "utf8"));
const out = `${root}ad-sentinel-v${manifest.version}.zip`;
await rm(out, { force: true });

if (process.platform === "win32") {
  // Windows PowerShell 5.1 の Compress-Archive はパスを「\」区切りで格納し、macOS・Linux で展開すると
  // icons/ フォルダができない(Chrome がアイコンを読めず読み込みに失敗する)。Windows 標準の bsdtar を使う
  const tar = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\tar.exe`;
  execFileSync(tar, ["-a", "-c", "-f", out, ...(await readdir(dist))], { cwd: dist });
} else {
  execFileSync("zip", ["-r", out, "."], { cwd: dist });
}

console.log(`作成: ${out}`);
console.log(`名前: ${manifest.name} v${manifest.version}`);
