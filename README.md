# 催化研究智能体

v0.1 的第一个开发里程碑覆盖前端基线、数据契约和可执行验收用例。吸附对照与实验动力学拟合是首发分析功能，MD 和设备场接收已有的计算结果。此提交可以在离线环境检查规范化 JSON、复核候选分析结果、验证运行清单及证据关系。原始文件读取器、拟合服务和工作台接入列在下一阶段。

## 在仓库根目录运行

使用内网已配置的 Python 3.13、Git 和本仓锁定的依赖。Windows 上可使用以下命令。

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

成功返回 0，校验失败返回非零。文件来自本地或经授权的内网存储。数据契约用项目内的工件 ID 引用数据。生产文件的鉴权、存储路径解析、量纲转换和导入时的逐字节验证由后续接入层负责。

### 还原前端

`frontend-baseline-v1` 是独立的带注释标签，树根就是前端发布目录。主分支保留清单和校验器，现有工作目录继续作为前端入口。可从本地仓库对原目录逐文件核验。

```powershell
py -3.13 scripts/frontend_baseline.py --source D:/project/E-PAO/e-pao-studio
```

备份或复制 Git 仓库时显式包含标签，例如 `git clone --tags <内网仓库路径> <新目录>`。单独分发前端时可用 `git archive --format=zip -o <目标目录>/frontend-baseline-v1.zip frontend-baseline-v1`。该快照含展示用图像和本地字体许可。

开发顺序、目录与版本规则见 [开发约定](docs/development.md)。发布前需要的证据与盘点项见 [验收表](docs/acceptance.md)。
