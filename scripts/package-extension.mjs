import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const releaseRoot = path.join(projectRoot, "release");
const packageName = "temu-commerce-workbench-extension";
const packageRoot = path.join(releaseRoot, packageName);

const runtimeEntries = [
  "manifest.json",
  "config.json",
  "src",
  "node_modules/xlsx/dist/xlsx.full.min.js"
];

async function main() {
  await rm(releaseRoot, { recursive: true, force: true });
  await mkdir(packageRoot, { recursive: true });

  for (const relativeEntry of runtimeEntries) {
    const sourcePath = path.join(projectRoot, relativeEntry);
    await ensureExists(sourcePath);
    const targetPath = path.join(packageRoot, relativeEntry);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await cp(sourcePath, targetPath, { recursive: true, force: true });
  }

  await writeFile(
    path.join(packageRoot, "安装说明.txt"),
    [
      "Temu 商品工作台扩展安装说明",
      "",
      `1. 解压整个 ${packageName} 文件夹（如果你收到的是压缩包）。`,
      "2. 打开 Chrome，进入 chrome://extensions/ 。",
      "3. 打开右上角“开发者模式”。",
      "4. 点击“加载已解压的扩展程序”。",
      `5. 选择当前文件夹：${packageName}`,
      "6. 安装完成后，点击扩展图标打开侧边栏即可使用。",
      "",
      "说明：",
      "- 这个发布包已经包含运行所需的 xlsx 浏览器脚本。",
      "- 不需要再执行 npm install。",
      "- 如果浏览器更新后扩展失效，请让提供方重新打一个新包。"
    ].join("\r\n"),
    "utf8"
  );

  console.log(`Packaged extension to: ${packageRoot}`);
}

async function ensureExists(targetPath) {
  try {
    await stat(targetPath);
  } catch {
    throw new Error(`Missing runtime file: ${path.relative(projectRoot, targetPath)}`);
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
