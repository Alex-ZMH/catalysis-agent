# MLCC 可视化迁移说明

这组组件从 Zeus/MatterAI 的 `packages/ui/src/server-agent/` 独立迁移而来，保留原组件的资源边界、解析预算、科学数据格式和安全预览规则。迁移入口是 `mountArtifactPreview.jsx`；它只依赖 MLCC 自己的 `types.ts`、`standalone/scientific-artifact.mjs` 和 `/api` 资源接口，不导入 `@zeus/*` 包或父平台运行时。

## 来源与覆盖

| 能力 | 迁移来源 | 当前行为 |
| --- | --- | --- |
| 晶体/分子结构 | `AtomicStructurePreview.tsx` | 沿用结构分类、3Dmol 样式、晶胞与下载能力 |
| 轨迹 | `TrajectoryVisualization.tsx` | ExtXYZ、XDATCAR、LAMMPS dump；保留帧切换、播放、晶胞和相机状态 |
| 体数据 | `VolumeVisualization.tsx` | CUBE、CHGCAR、ELFCAR；保留等值面、阈值和边界框 |
| 能带/态密度 | `ScientificPlotVisualization.tsx` | EIGENVAL、DOSCAR；沿用 JSON 资源校验、抽稀和键盘/指针读数，标题使用“能带图/态密度图” |
| SVG | `SvgPreviewSanitizer.ts` | 只生成清洗后的 Blob；脚本、事件、外部资源和危险引用会被移除 |
| Word/PowerPoint | `OfficeArtifactPreview.tsx` | 只提取受预算约束的文字/表格；损坏或超限文件回退下载 |
| CSV/TSV | 原 `ServerAgentResultsPanel.tsx` 的 `parseDelimited` | 先完整读取最多 1 MiB，再限制为 100 行、50 列并明确提示；React 文本节点不会执行单元格内容 |
| HTML | 原 `buildHtmlSrcDoc` | 完整读取最多 512 KiB；`sandbox=""` iframe，CSP 禁止脚本、网络、表单、导航 |
| JSON/Markdown/TXT | 原源码预览 | 完整读取最多 512 KiB；Markdown 正文按标记排版，底部可下载原文，JSON/TXT 保留源码视图 |
| PDF | MLCC 独立扩展 | 使用 `pdfjs-dist` 画布渲染、分页和缩放；失败时保留原文件下载 |

通用预览在响应声明的 `Content-Length` 超限时立即拒绝；没有声明时通过 `ReadableStream` 分块累计并在越界时取消 reader。SVG 最多 2 MiB 且清洗完整源，图片最多 25 MiB，结构文件最多 10 MiB，Office/PDF 最多 25 MiB，科学可视化资源最多 256 MiB。超出预览预算时显示明确回退原因。未知格式不读取 Blob，下载使用同源、带认证的原始 artifact 链接，由浏览器直接流式下载。

原版 `previewKind` 只把 DOCX/PPTX 归入 Office，未提供 XLSX 解析；MLCC 也不宣称支持 XLSX。原版对 PDF 走下载回退，MLCC 为嵌入式浏览器增加画布预览。CSV 是表格展示而非曲线推断，HTML 仍禁止脚本执行。

## 接口边界

`mountArtifactPreview(container, { artifact, apiBase, onClose, onAuthExpired })` 返回 `{ destroy() }`。`apiBase` 由宿主指定（当前为 `/api`，部署在子路径时也可为 `/mlcc/api`），所有请求都使用同源认证会话。

科学结果先请求 `${apiBase}/artifacts/:id/visualization`，资源按 manifest 的 `resource.id` 请求 `${apiBase}/artifacts/:id/visualization/resources/:resourceId`；普通原文件沿用 `${apiBase}/artifacts/:id`。manifest 的 `source` 必须与附件 `id/name/mimeType/sequence:1` 完全一致。原文件下载使用带认证的原生链接，让浏览器直接流式下载，不把未预览的大文件读入前端内存。

## 对话内结果面板

结果卡片打开独立的右侧对话框。面板根节点位于消息列表之外，预览组件不会因为消息流式更新而重复挂载。面板维护当前账号和当前对话范围内的多标签：

- “对话结果”下拉框列出当前对话已产生的所有结果；选择结果会打开或重新选中对应标签。
- 标签按 artifact id 去重，点击标签切换预览；关闭当前标签后选择相邻标签并恢复焦点，关闭后台标签不会重置当前预览。
- `ArrowLeft`/`ArrowRight`、`Home`、`End` 可切换标签，`Delete` 关闭当前标签；关闭面板会销毁当前预览并保留该对话的标签。切换对话、退出账号或新建对话时会清空标签。
- `onAuthExpired` 交给宿主重新登录；可视化组件自身只负责取消请求、释放对象 URL、PDF.js loading task 和 3D viewer。

正文中的真实相对结果引用只从当前对话和已加载的历史结果中匹配：Markdown 链接或行内代码中的文件名/相对路径必须精确命中授权 artifact 的 `name/path` 才会变成可点击预览。`..`、绝对 URL、反斜杠、空路径和未匹配路径均不会被当作文件引用；普通正文始终转义，图片语法不会触发远程请求，普通 `http(s)` 链接才按外链打开。当前对话结果优先于历史同名结果，歧义引用保持为普通文本。

## 本地验证

在 `mlcc-studio` 目录执行：

```sh
./node_modules/.bin/tsx --test src/visualization/tests/*.test.ts src/visualization/tests/*.test.tsx
npm run build
```

测试覆盖 manifest 安全解析、派生格式路由、科学图抽稀与键盘/指针读数、SVG 清洗、Office 损坏包、600018 字节 CSV、恶意单元格、HTML CSP、octet-stream 扩展名路由、声明/实际字节上限、原生下载 URL、能带/态密度标题以及 PDF.js loading task 清理。

本文档描述当前代码接口和本地验证边界，不代表已经完成公网部署或所有真实浏览器环境的最终验收。
