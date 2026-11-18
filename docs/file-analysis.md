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

## A5 现场盲验

数据负责人先向分析人员交付脱敏原件、单位与采样协议，并交付独立参考文件的 SHA-256。参考文件由数据负责人另行保管，其中的单位、样本位置、预期值、缺失掩码与容差随指纹一起固定。两种参考格式见 [LAMMPS 导入](lammps-import.md) 和 [设备剖面](equipment-import.md)。

1. 在工作台只上传原件。VTU 先指定 A、B、字段、点或单元关联、分量及采样位置，保存需要验收的全部剖面。成功后记录运行 ID。
2. 在集群使用下面的 freeze 命令。回执绑定运行清单、代码版本、原件、参数、结果、分析详情和参考指纹。将命令输出的回执 SHA-256 在揭盲前交给复核人单独留存。
3. 复核人披露原参考文件，使用留存的回执 SHA-256 执行 reveal。命令检查所有工件后直接读取冻结坐标和剖面，逐帧逐点比较。每个冻结剖面都要有唯一对应的参考。结果报告记录审核状态、误差和文件指纹。参考文件或数值不符时返回非零状态。相同路径只接受字节完全相同的证据，复验其他参考须使用新的输出路径。

在版本化的 V100 代码目录内执行。工作台数据目录和证据目录位于仓库外。下例中的变量由项目操作员按实际路径和运行 ID 提供。

```bash
python -m packages.agent.blind freeze \
  --data-dir "$WORKSPACE" --project "$PROJECT" --run-id "$RUN_ID" \
  --reference-sha256 "$REFERENCE_SHA256" --receipt "$EVIDENCE/receipt.json"

python -m packages.agent.blind reveal \
  --data-dir "$WORKSPACE" --project "$PROJECT" --receipt "$EVIDENCE/receipt.json" \
  --receipt-sha256 "$RETAINED_RECEIPT_SHA256" --reference "$REFERENCE" \
  --report "$EVIDENCE/report.json"
```

同一账户下的合成演练可以验证冻结和比较流程。现场盲验的保密性和留存时间由独立持有参考与回执的人员负责。

## A6 人工确认

在工作台的科学分析面板打开「重计算计划」，选择已有运行、工作流程、CPU、GPU 和时限，点击「创建计划」。核对来源文件、SHA-256、计划摘要和执行方式后再确认。从「已创建的计划」可在刷新或服务重启后继续查看事件和 Slurm 作业号。

VASP 弛豫、MD 和设备仿真在当前版本保存人工确认记录。常规计划的资源字段接受 1–256 个 CPU、0–8 个 GPU、1–10080 分钟，用于记录申请值，现场容量由集群另行核定。管理员在 V100 启动服务时显式传入 `--a6-synthetic-slurm`，才可为合成来源选择 `synthetic-v100`。这个模板使用 gpu 分区、1 张 V100、1–2 个 CPU、1–2 分钟，在 GPU 上计算 32 个可独立复核的整数。授权范围与来源信息一起写入计划。

| 页面状态 | 可执行的操作 |
| --- | --- |
| 待人工确认 | 核对摘要，确认普通计划或启动指定合成作业 |
| 提交前检查失败 | 处理原因后点击「确认重试」 |
| 已受理确认、提交结果待核对 | 点击「查询回执」，按固定计划标记核对 Slurm 和已保存的回执。没有可信回执时保持待核对 |
| 已关联 Slurm 作业 | 查看作业号和审计记录，计算完成情况以 Slurm 终态和 GPU 结果为准 |

在同一项目内，相同输入、流程、资源和执行策略获得同一计划 ID。工作台在调用调度器前把提交权写入 SQLite。Slurm 无法与 SQLite 一起提交事务，因此中断可能留下尚无作业号的计划；此时按既有标记查证，重复确认不能再次派发。人工确认的持久化记录在项目数据目录的 `approvals/approvals.sqlite3`，调度脚本、日志和回执在 `approvals/slurm/<plan_id>/`。保留并共同备份这两个位置，使用本机支持锁和持久刷盘的文件系统。确认人取自服务启动时指定的操作员，生产账户授权仍按 A1 签收。

## A7 项目备份、恢复与复算

在 V100 的版本化代码目录使用项目 Python 环境。备份前关闭该项目工作台，等仍在写回执或日志的作业结束。一个归档对应一个项目，包含科学工件、运行历史、当时的审批数据库和项目内已有的调度证据。归档外的现场参考、软件环境和集群控制器日志按各自位置保管。

```bash
python -m packages.recovery backup --data-dir "$SOURCE_ROOT" --project "$PROJECT" \
  --archive "$BACKUP_DIR/project.zip" > "$EVIDENCE/backup.json"

python -m packages.recovery restore --archive "$BACKUP_DIR/project.zip" \
  --sha256 "$RETAINED_SHA256" --data-dir "$RESTORE_ROOT" > "$EVIDENCE/restore.json"

python -m packages.recovery replay --data-dir "$RESTORE_ROOT" --project "$PROJECT" \
  --destination "$REPLAY_ROOT" > "$EVIDENCE/replay.json"
```

先准备私有的备份目录和证据目录。将第一条命令返回的 `archive_sha256` 单独留存，作为恢复命令的 `RETAINED_SHA256`。选择独立的恢复数据根，其中该项目的位置必须空缺。复算使用第三个空目录，根据已保存的输入、参考文件和参数重新运行科学分析。报告列出原运行与复算运行对应的代码版本和工件哈希。用命令退出状态和逐项报告共同判断结果。

使用 `python -m apps.server --data-dir "$RESTORE_ROOT" --project "$PROJECT" --operator "$REVIEWER"` 打开恢复副本。在「科学分析」的运行历史中选择原运行，核对清单中的参数、输入和结果工件，下载原文件核对 SHA-256。在「重计算计划」中选择历史审批，核对来源运行、文件哈希、操作员、事件和原 Slurm 作业号。已归档的合成 GPU 计算回执可以从作业号下方下载。恢复副本的审批历史只读，包含恢复前仍在待确认、可重试或待核对状态的记录。科学复算只生成独立运行记录。

## A1 内网账号、项目权限和审计

在 V100 上用专用服务账户管理数据。数据根与备份目录使用权限 `0700`，策略和审计文件使用 `0600`。将策略、审计、归档目录放在项目树外。服务监听 `127.0.0.1`，工作台通过内网 SSH 转发打开。受管服务启动时加载 Linux seccomp 过滤器，只使用启动阶段绑定的监听器响应连接，服务进程及其子进程无法新建套接字或主动连接。

操作员通过交互终端执行 `python -m packages.agent.access hash-password` 生成盐化密码校验值。在服务账户私有的策略文件中逐人登记权限。下面的 `<校验值>` 都应替换为各自终端生成的值。

```json
{"users":{"alice":{"password_hash":"<校验值>","projects":{"alpha":"admin"}},"bob":{"password_hash":"<校验值>","projects":{"beta":"analyst"}}}}
```

| 项目角色 | 工作台能力 |
| --- | --- |
| `viewer` | 查看获授权项目的运行、原件、参数、结果和审批 |
| `analyst` | 查看项目记录，导入和分析文件，创建和确认普通计划 |
| `admin` | 拥有分析员权限，可查看和下载已发布的项目备份 |

角色仅在指定项目内有效。变更策略后重启服务，重新登录即可使用新权限。密码和会话只用于登录，日志不保存密码、会话 ID、文件名或数据内容。审计 JSONL 包含 UTC 时间、请求 ID、账号、项目、操作、结果和 HTTP 状态，可用响应的 `X-Request-ID` 关联。受管数据根一旦初始化，工作台必须继续使用受管启动方式。

```bash
python -m apps.server --data-dir "$DATA_ROOT" --access-policy "$POLICY" \
  --audit-log "$AUDIT_LOG" --backup-root "$BACKUP_ROOT" --port 8771
```

登录后使用「当前项目」选择已授权的项目。备份由运维人员按 A7 步骤生成，再放入对应项目的归档目录。将完成的文件以 `0600` 权限放入 `$BACKUP_ROOT/<项目>/<归档 SHA-256>.zip`。同名归档保留既有文件。工作台在读取备份前验证归档摘要和内嵌项目标识。对应项目管理员可从「项目备份」下载。
