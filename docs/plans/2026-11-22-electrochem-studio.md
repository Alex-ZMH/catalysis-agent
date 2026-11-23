# Electrocatalysis Studio Implementation Plan

**目标**：独立打开电催化工作台；无需连接 MLCC、模型、集群或 CDN，即可从输入绘制 HER/OER 自由能图、检查位点坐标。

**设计**：保留现有项目服务、审批及文件分析。沿用 MLCC 的「问题 → 选择工具 → 核对输入 → 可视化读数」方式，使用浏览器原生 SVG/Canvas 而非复制电容器求解器。可选模型进程单独复用 MLCC 的模型协议客户端，不在浏览器保存密钥。

1. 在 `tests/electrochem.test.cjs` 先固定 HER/OER 电位符号、理想极限与并列步、XYZ 单位和拒绝无效输入的行为。用 `node --test tests/electrochem.test.cjs` 观察失败并实现离线科学工具。
2. 在 `apps/web/electrochem/` 将工具接入工作台问题与直接入口。用用户输入或明确标记的示例展示；不把电子吸附能当自由能，不从坐标推断化学键或位点活性。
3. 在 `tests/test_studio_runtime.py` 验证无历史标签启动和模型桥接协议；在 `apps/server.py`、`packages/agent/model_broker.*` 解耦路径，在 README 记录轻量和完整两种运行模式。
4. 在独立静态目录和完整服务上做浏览器验收，再运行科学单测和已有回归。不要改动 MLCC 仓库、发送真实模型请求或提交计算任务。
