# Temu 商品处理工作台

这是一个统一侧边栏版本。它把原来的 1688 核价录入工具和 Temu GPT 主图自动化工具放到同一个侧边栏里，旧功能优先保持原样。

## 开发验证

```powershell
npm test
```

## Chrome 加载

1. 打开 `chrome://extensions/`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择 `D:\learning\temu-commerce-workbench`
5. 点击扩展图标打开侧边栏

## 打包给同事

```powershell
node scripts/package-extension.mjs
```

打包后会生成：

- `release/temu-commerce-workbench-extension`

把这个文件夹整体压缩后发给同事即可。同事解压后，在 Chrome 的 `chrome://extensions/` 里打开“开发者模式”，再点“加载已解压的扩展程序”，选择解压后的文件夹。

## 当前可用流程

侧边栏包含三个页签：

- `T2 交集`：处理价格表与信息表交集，并打开固定 HTML 预览页动态查看商品卡片。
- `1688 核价`：保留原 1688 商品录入工具，包括 T2 预览页传输、当前 1688 页面抓取、利润计算、粘贴图片、保存 JSON、导出 Excel。
- `GPT 主图`：保留原 Temu GPT Main Image Automator，包括选择图片文件夹、两段式规划/执行、自动下载、暂停/继续/停止、导出日志。

注意：如果要从本地 `result.html` 传输商品到 1688 核价页签，需要在扩展详情里打开“允许访问文件网址”。

## 架构方向

- `src/domain`: 商品模型、核价、状态流转
- `src/application`: 用例编排
- `src/infrastructure`: Excel、Chrome、1688、存储等适配器
- `src/presentation`: 扩展 UI 和后台脚本
