# 工作台文件分析

在仓库根目录运行 `py -3.13 -m apps.server --project local --data-dir D:/research-data/catalysis-agent`，打开 `http://127.0.0.1:8771/#studio`，点击页眉的「科学分析」。项目与操作员由本机启动参数确定。当前服务仅监听 127.0.0.1，校验浏览器来源，界面、字体、文档、选项和计算均在本机。工作台使用冻结标签的发布文件，在运行时加入科学分析入口。

## 从文件到结果

| 入口 | 操作 | 核对结果 |
| --- | --- | --- |
| LAMMPS 轨迹 | 上传原生文本 dump，按文件元数据或表单声明长度单位，可另附独立参考 JSON | 按步号定位每一帧，按原子 ID 核对笛卡尔坐标、盒原点、基矢和周期性。每帧报告最大坐标误差，缺少物理时间映射时仅显示步号 |
| VTU 场与线剖面 | 上传串行单 Piece VTU，可附独立参考 JSON，或在表单中指定 A、B、字段、点或单元关联、分量和采样数 | 逐点查看采样值、参考值、绝对误差和缺失掩码。同名点场与单元场可分别查看，单元间的跳变得以保留 |
| VASP 吸附能 | 选择来源，上传含 `study.json`、各阶段 `vasprun.xml` 及补充证据的 ZIP；按项目需要收紧各轴限值 | 比较同一参考定义下的 eV/吸附单元，查看每个构型的能量、可比状态、原晶胞长度和排序。能量采用末离子步 `e_fr_energy`，电子收敛代理量、结构来源及补充证据见分析详情 |
| 动力学拟合 | 选择 CSV 或 XLSX、模型、温度和响应单位；有多张工作表时选表名，自定义表头可逐列映射。幂律另选反应物浓度列、转化率列及单位 | 训练集估计参数，留出集单独检验。显示活化能与指前因子或各反应级数与参考速率，保留残差、秩、批次划分、参数区间状态和原表行号 |
| 晶胞预检与构建 | 上传已切面的 POSCAR，设 a、b、c 复制倍数。保留现有真空或输入所需的法向总真空间距，选择生成 POSCAR | 以最终三根晶格矢量的模长验收，每轴 ≤50 Å，含真空。尺寸合格可下载候选结构；超限显示实际尺寸和方向，调整复制倍数或真空后可重新预检。构建返回原子映射，保留原结构文件 |

在「运行历史」打开任一成功发布的分析，查看来源与下载。运行清单将方法版本、代码提交、参数、规范化输入与结果指向原始上传工件。VASP 还可下载包内使用过的 XML 和证据文件；表格保留完整原文件和工作表行映射。原表缺失的测量不确定度单独标记。解析、质量阈值或模型适用条件未通过时展示原因，该次请求不发布为新运行。

具体字段和示例见 [VASP 导入](vasp-import.md)、[动力学导入](kinetics-import.md) 和 [晶胞预检](cell.md)。

轨迹和设备场的格式、单位、容差及支持范围见 [LAMMPS 导入](lammps-import.md)、[VTU 采样](equipment-import.md) 和 [VTU 文件编码](vtu-format.md)。两种导入都可以单独上传原件。上传独立参考后，运行清单将原件与参考分别记录为输入。比较失败时页面给出对应的帧或采样位置。

## 数据与运行边界

- 数据位于外置数据根下的 `projects/<project_id>/raw/<sha256前两位>/<sha256>` 和 `projects/<project_id>/runs/<run_id>/`。运行目录原子发布，重启后可回读；同一项目、操作员、代码版本、文件名、原始内容、配置和来源的重复请求复用同一记录。原始上传与分析结果均按字节哈希存储。
- `--port`、`--data-dir`、`--project`、`--operator` 可调整。请求体上限默认 64 MiB，并发分析槽位默认 2 个，可用 `--max-upload-mib` 和 `--workers` 调整。各解析器的资源预算见对应指南。
- 当前吸附入口读取已有 VASP XML，结构工具从已切表面开始；体系适用性、真空与层厚的收敛仍需相应证据。当前动力学实现为对数空间非加权最小二乘，Arrhenius 使用已测速率常数，初始速率幂律在固定温度下拟合。源文件带公式时请提供数值导出。
- 节点、模型服务、软件授权和脱敏数据继续待盘点。本次两条链路可离线运行，实际项目数据的盲测及多用户内网部署另行签收。没有集群提交入口。

## 重现浏览器验收

先启动独立的合成项目，再将测试文件生成到新的仓外空目录。测试驱动实际点击页面，核对可比位点、动力学参数、原文件下载、刷新后的历史、含真空的上限和超限拒绝。浏览器测试只允许页面向所选回环地址发请求。

```powershell
py -3.13 -m unittest discover -s tests -v
py -3.13 scripts/synthetic_inputs.py D:/research-data/catalysis-agent/acceptance/inputs-new
py -3.13 -m apps.server --project synthetic-acceptance --operator Astra --data-dir D:/research-data/catalysis-agent
```

另开终端，将 `CHROME_BIN` 指向本机 Chrome 可执行文件，`NODE_PATH` 指向已获准安装的 `playwright-core` 所在的 `node_modules`。本次验收使用 playwright-core 1.62.1。

```powershell
node tests/browser_workbench.cjs http://127.0.0.1:8771 D:/research-data/catalysis-agent/acceptance/inputs-new
```

A5 的复跑命令如下。最后一个可选目录用于保存浏览器实拍。

```powershell
py -3.13 scripts/synthetic_inputs.py --suite a5 D:/research-data/catalysis-agent/acceptance/a5-inputs
node tests/browser_a5.cjs http://127.0.0.1:8771 D:/research-data/catalysis-agent/acceptance/a5-inputs D:/research-data/catalysis-agent/acceptance/a5-screens
```
