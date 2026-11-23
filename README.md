# 催化研究智能体

工作台可以从 VASP 输出包做吸附对照，从实验 CSV/XLSX 拟合动力学参数，从 LAMMPS 轨迹按步号查看原子坐标，以及从 VTU 网格提取点场或单元场的 A–B 线剖面。轨迹和剖面均可随原文件上传独立参考，查看比较结果。每次运行均可下载原文件并核对 SHA-256。晶胞工具从已切好的表面 POSCAR 构建候选，检查含真空的三轴尺寸。

## 启动并对话

macOS 双击 `start.command`，或在仓库根目录执行 `./start.command`。本机已配置 V100 SSH 时，启动器会打开 [电催化研究助手](http://127.0.0.1:8773/#studio)，并自动登录本机账号。在输入框中直接提问，用侧栏「最近对话」接着研究。

- **计算电催化自由能**。例如「在 −0.08 V vs RHE，0 V 时 ΔG(H*) = 0.21 eV，HER 两步的自由能分别是多少？给我图和表。」助手可调用 CHE 工具并在对话内发布 SVG 与 CSV。
- **提交 ABACUS 作业**。例如「请实际提交一次镍参考单点 SCF，完成后给我原始日志和结构。」也可以指定自己的晶胞、分数坐标、自旋初值、截断能及 k 点网格。专用单点工具支持站点映射的 Ni、O、Ca、Zr，限 16 个原子、单进程、5 分钟。其他任务由 MLCC 运行时和站点方法合同决定。
- **查看结果**。点击对话里的文件或引用即可打开多标签结果面板，可查看三维结构、轨迹、等值面、能带、态密度和文档，并下载原件。停止回答后可在同一对话继续查询已提交作业。

服务需要本机 Python 3、Node.js 22.18+、npm、OpenSSH，以及已配置引擎的 V100 节点。首次启动自动构建前端。SSH 连接配置位于 `~/.config/catalysis-agent/mlcc-worker.json`，仅含 `host`、`user`、`port`。SSH 认证由终端或本机密钥处理。站点的模型配置、Python MCP 和 ABACUS 来自 V100 上已有的 MLCC 安装。本地运行无需同级 MLCC 源码，也无需启动其网站。

本机服务只监听环回地址。对话、账号和结果保存在 `~/.local/share/catalysis-agent/research-studio/`，远端作业保存在 `~/projects/catalysis-agent/jobs/research-studio/`。终端窗口保持打开，重启后可继续现有对话。验收记录见[计算与可视化核对](docs/studio-parity-audit.md)。

## 便携离线版（无需安装依赖）

直接打开 `apps/web/electrochem/index.html`，点「进入工作台」。也可在仓库根目录运行下列命令后打开 `http://127.0.0.1:8772/#studio`。只复制整个 `apps/web/electrochem/` 目录到另一台电脑也能运行这套工具；不需要 MLCC、Git、Node、API Key 或互联网。

```sh
python3 -m http.server 8772 --bind 127.0.0.1 --directory apps/web/electrochem
```

- **从问题开始**：点快捷问题只填入输入框，点击「发送」才执行；记录自动保存在当前浏览器。也可展开分析工具使用表单。离线版不调用模型或提交集群作业。
- **HER / OER 自由能图**：输入同一参考态下的自由能（eV）和电位（V vs RHE），对照 0 V 与指定电位的反应路径，读出逐步 ΔG、限制电位、理论过电位及并列的电位决定步。可下载带输入与来源标记的 JSON。「载入教学示例」提供演示数值，与实测及第一性原理计算结果分开。
- **位点结构**：打开单帧标准 XYZ 文件，旋转坐标投影，点选原子查看原始 Å 坐标。最多 2000 原子 / 256 KiB。预览不识别化学键、不计算位点活性；文件不上传，原子坐标仅保留在当前页面。

**模型口径**：标准态 298.15 K，单活性位、每步一个质子–电子对。HER 选 Volmer–Heyrovsky，0 V 累计能级为 `[0, ΔG(H*), 0]`，第 n 态加 `nU`；OER 选吸附物演化机制，能级为 `[0, ΔG(OH*), ΔG(O*), ΔG(OOH*), 4.92]`，第 n 态减 `nU`。H* 以 ½H₂ 为参照；氧化中间体以裸位点、液态水和气态氢为参照（例如 ΔG(OH*) = G(OH*) − G(*) − G(H₂O) + ½G(H₂)）。限制电位对应各步均不再上坡的边界，不是实测起始电位或活化能垒。背景：Nørskov 等，*Trends in the Exchange Current for Hydrogen Evolution*；Man 等，*Universality in Oxygen Evolution Electrocatalysis on Oxide Surfaces*。

## 完整项目服务

使用内网已配置的 Python 3.13、Git 和本仓锁定的依赖。Windows 上可使用以下命令。

```powershell
py -3.13 -m apps.server --data-dir D:/research-data/catalysis-agent --project local
```

在浏览器打开 `http://127.0.0.1:8771/#studio`，点击页眉的「科学分析」。使用流程、支持的输入、模型尺寸规则和浏览器验收见 [文件分析工作台](docs/file-analysis.md)。项目备份、独立恢复和复算使用同一指南中的 [A7 操作步骤](docs/file-analysis.md#a7-项目备份恢复与复算)。以下命令独立核验基线和契约。

```powershell
py -3.13 scripts/frontend_baseline.py
py -3.13 -m unittest discover -s tests -v
py -3.13 -m packages.check profile configs/profiles/intranet.json
py -3.13 -m packages.check --help
```

缺少 Python 依赖时，从管理员核实的内网 wheel 目录安装。将路径替换成实际目录，命令不会访问包索引。

```powershell
py -3.13 -m pip install --no-index --find-links <内网wheel目录> -r requirements.lock
```

macOS / Linux 使用 `python3.13 -m apps.server --project local`。完整服务可用本仓 Git 工作树，或使用 `git archive --format=zip -o catalysis-agent.zip HEAD` 分发**已提交的版本**。后者由 Git 写入真实源码提交号，目标机不需要 Git。缺少 `frontend-baseline-v1` 只会隐藏历史「通用催化图景」；研究记录仍须有真实提交号，不要将普通文件夹复制冒充发布包。

### 可选：启用模型助手

**直接使用 MLCC 的在线模型**：双击 `start.command` 时，如果存在 `~/.config/catalysis-agent/mlcc-worker.json`，启动器会通过 SSH 接到 MLCC 的模型配置。该 JSON 只包含 `host`、`user`、`port`；不要放密码、API Key 或 worker token。首次使用前需核实并信任 SSH 主机指纹。启动时在终端按 SSH 提示登录即可，也可使用已授权的 SSH 密钥。手动启动命令是 `python3.13 -m apps.server --mlcc-worker-config ~/.config/catalysis-agent/mlcc-worker.json`。若需切回离线模式，停止服务并直接运行不带模型参数的 `python3.13 -m apps.server`。

以下连接方式用于 8771 文件分析服务。此模式不启动或修改 MLCC 网站。每个桥接会话在远端的临时目录加载本仓的电催化工具，并调用 MLCC 已安装的模型客户端；仅在远端读取 `~/mlcc-independent/config/worker.env` 中的四个模型字段。对话和图表结果返回本机，模型密钥与 worker token 不传回。断开 SSH 后，重新启动服务并登录即可。发送开放问题测试自由对话；测试真实模型工具调用请用带单位的自有数值，以自然语言要求计算，而不是发送「运行示例」。

**为 8771 文件分析服务另行指定模型**：不使用 SSH 时，也可安装 Node.js 22.18+，用 `python3.13 -m apps.server --model-config /私有目录/catalysis.env` 启动。Node 取自 PATH，也可用 `CATALYSIS_NODE` 指定可执行文件。配置文件放在仓库和静态资源目录之外：

```dotenv
CATALYSIS_MODEL_BASE_URL=http://127.0.0.1:8000/v1
CATALYSIS_MODEL_API_KEY=replace-with-your-provider-key
CATALYSIS_MODEL=replace-with-your-model
CATALYSIS_MODEL_API_FORMAT=chat-completions
```

模型服务需支持工具调用；也支持 `responses` 协议。配置后，发送会将当前问题和最近对话文本交给指定供应商，请勿粘贴不应外发的数据。模型可直接回答、打开查看器或根据用户提供的带单位数值调用本地 CHE 计算；不传结构文件，不提交集群任务。停止会取消正在等待的模型回复，不回滚既有研究记录。受管模式仅向获授权的 analyst/admin 提供发送入口。启动脚本也支持 `CATALYSIS_MODEL_CONFIG=/私有目录/catalysis.env ./start.command`（先停止旧服务）。原 `--mlcc-model-config` 仅供运维使用既有授权的动力学拟合配置，不会自动将一般对话交给该供应商。

上文 8771 的 Python 文件分析服务可通过 `CATALYSIS_ANALYSIS_ONLY=1 ./start.command` 单独启动。8773 研究助手使用本仓 `apps/research/` 中的 MLCC 对话与结果代码和电催化 worker。两个入口各自保存历史记录。

### 校验研究记录

| 命令中 `packages.check` 后面的参数 | 校验内容 |
| --- | --- |
| `run <manifest.json>` | 项目归属、配置版本、输入输出、哈希字段和证据依赖 |
| `adsorption-input <input.json>` 或 `kinetics-input <input.json>` | 科学输入的结构及适用条件 |
| `adsorption <result.json> --input <input.json>` 或 `kinetics <result.json> --input <input.json>` | 使用对应输入重新核对候选结果 |
| `md <normalized.json>` 或 `equipment <normalized.json>` | 已规范化的轨迹、时序或网格场 |
| 在以上结果命令末尾加 `--run <manifest.json>` | 进一步核对科学操作、结果文件的实际字节及其原始证据链。两个分析命令还核对规范化输入文件的实际字节 |

成功返回 0，校验失败返回非零。工件按项目保存，传入分析、结果回读和下载均可校验其内容。当前进程只监听本机回环地址，以启动时指定的项目和操作员运行。共享内网的多用户身份、授权和网关部署仍待现场接入。

### V100 电催化研究助手

白底聊天与结果预览由 `catalysis-research-server.service` 提供，在 V100 本机监听 `127.0.0.1:8773`。同机的 `catalysis-research-worker.service` 读取已有 MLCC 模型配置，处理电催化队列。两者均为 v100 用户的 systemd 常驻服务。账号、对话和附件保存在 `~/projects/catalysis-agent/public-research/data/`，计算工作目录位于 `~/projects/catalysis-agent/jobs/public-research-studio/`。注册邀请码由部署账号保存在私有的 `~/.config/catalysis-public-research/server.env`。

白底研究助手已在 [催化工作台](https://agent.mattok.cn/catalysis/) 上线，使用独立研究账号。前端用 `npm run build -- --base=./` 构建。网关文件 `/etc/nginx/snippets/catalysis-studio-location.conf` 中的 `/catalysis` 和 `/catalysis/` 两个 location 使用 [gateway-location.conf](apps/research/deploy/gateway-location.conf)。后续发布只更新这两段，同一文件还包含其他路径。网关保留请求前缀，经已有的 18771 端口转到 [V100 转发服务](apps/research/deploy/v100-relay.conf) 的 8771 端口。切换前的网关配置保存在 `/opt/catalysis-studio/backups/catalysis-location-before-white-20261122T165330Z.conf`。

### 还原前端

`frontend-baseline-v1` 是独立的带注释标签，树根就是前端发布目录。主分支保留清单和校验器，现有工作目录继续作为前端入口。可从本地仓库对原目录逐文件核验。

```powershell
py -3.13 scripts/frontend_baseline.py --source D:/project/E-PAO/e-pao-studio
```

备份或复制 Git 仓库时显式包含标签，例如 `git clone --tags <内网仓库路径> <新目录>`。单独分发前端时可用 `git archive --format=zip -o <目标目录>/frontend-baseline-v1.zip frontend-baseline-v1`。该快照含展示用图像和本地字体许可。

开发顺序、目录与版本规则见 [开发约定](docs/development.md)。发布前需要的证据与盘点项见 [验收表](docs/acceptance.md)。
