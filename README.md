# 催化研究智能体

工作台可以从 VASP 输出包做吸附对照，从实验 CSV/XLSX 拟合动力学参数，从 LAMMPS 轨迹按步号查看原子坐标，以及从 VTU 网格提取点场或单元场的 A–B 线剖面。轨迹和剖面均可随原文件上传独立参考，查看比较结果。每次运行均可下载原文件并核对 SHA-256。晶胞工具从已切好的表面 POSCAR 构建候选，检查含真空的三轴尺寸。

## 在仓库根目录运行

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

### 校验研究记录

| 命令中 `packages.check` 后面的参数 | 校验内容 |
| --- | --- |
| `run <manifest.json>` | 项目归属、配置版本、输入输出、哈希字段和证据依赖 |
| `adsorption-input <input.json>` 或 `kinetics-input <input.json>` | 科学输入的结构及适用条件 |
| `adsorption <result.json> --input <input.json>` 或 `kinetics <result.json> --input <input.json>` | 使用对应输入重新核对候选结果 |
| `md <normalized.json>` 或 `equipment <normalized.json>` | 已规范化的轨迹、时序或网格场 |
| 在以上结果命令末尾加 `--run <manifest.json>` | 进一步核对科学操作、结果文件的实际字节及其原始证据链。两个分析命令还核对规范化输入文件的实际字节 |

成功返回 0，校验失败返回非零。工件按项目保存，传入分析、结果回读和下载均可校验其内容。当前进程只监听本机回环地址，以启动时指定的项目和操作员运行。共享内网的多用户身份、授权和网关部署仍待现场接入。

### 还原前端

`frontend-baseline-v1` 是独立的带注释标签，树根就是前端发布目录。主分支保留清单和校验器，现有工作目录继续作为前端入口。可从本地仓库对原目录逐文件核验。

```powershell
py -3.13 scripts/frontend_baseline.py --source D:/project/E-PAO/e-pao-studio
```

备份或复制 Git 仓库时显式包含标签，例如 `git clone --tags <内网仓库路径> <新目录>`。单独分发前端时可用 `git archive --format=zip -o <目标目录>/frontend-baseline-v1.zip frontend-baseline-v1`。该快照含展示用图像和本地字体许可。

开发顺序、目录与版本规则见 [开发约定](docs/development.md)。发布前需要的证据与盘点项见 [验收表](docs/acceptance.md)。
