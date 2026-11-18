# LAMMPS 作业配置与运行

在「科学分析」的 VASP 结果中选择结构旁的「配置 MD 作业」，或直接打开「LAMMPS 作业配置」上传 POSCAR、CONTCAR、`vasprun.xml`。作业包包含所选原始结构、工件来源、解析后的晶胞、明确配置和生成的 LAMMPS 输入文件。选择 EAM 时一并上传适用的原始势文件。

## 配置字段

| 字段 | 单位和选法 |
| --- | --- |
| `integrator` | `nve` 或 `nvt`。NVT 需要 `damping_ps`，目标温度取 `initial_temperature_K` |
| `dt_ps` | ps，正数。1 fs 写作 0.001 ps。按力场最快运动、温度和体系选择时间步 |
| `steps`、`thermo_every`、`dump_every` | 以步计，正整数。总时间为 `steps × dt_ps` |
| `initial_temperature_K`、`seed` | 初始温度 K。正温度生成初速度。NVE 可显式设为零。种子为 1–900000000 的整数 |
| `boundary` | x、y、z 分别填 `p` 周期、`f` 固定、`s` 收缩或 `m` 带下限收缩。拥有真空的表面可按具体实验设计选择法向条件 |
| `force_field` | `lj/cut` 要显式给出每种原子类型组合的 `i`、`j`、`epsilon_eV`、`sigma_A` 及全局 `cutoff_A`。 `eam/alloy` 要给出 `elements`，按类型编号排列，并附 setfl 势文件 |
| `structure_options` | 可选。 `mass_overrides` 指定质量 g/mol。旧式无元素标签的 POSCAR 用 `species` 指明计数行的顺序 |

下例是单一原子类型的合成烟测配置。实际研究请提供体系适用的力场和工况。

```json
{
  "integrator": "nve",
  "steps": 40,
  "dt_ps": 0.001,
  "initial_temperature_K": 100,
  "seed": 291011,
  "thermo_every": 10,
  "dump_every": 10,
  "boundary": ["p", "p", "p"],
  "force_field": {
    "style": "lj/cut",
    "cutoff_A": 4.5,
    "pairs": [{"i": 1, "j": 1, "epsilon_eV": 0.005, "sigma_A": 1.8}]
  }
}
```

## V100 运行

在已有 Slurm 分配的计算节点中，用项目版本化代码和场地已配置的 LAMMPS 可执行文件运行。每次选择新的结果目录，便于保留原作业和重试记录。

```bash
python -m packages.md_run --job-bundle "$JOB_BUNDLE" \
  --engine "$LAMMPS_EXECUTABLE" --output-dir "$RUN_DIR"
```

独立进入时，也可使用 `--structure` 和 `--config` 直接生成并运行。EAM 势文件随 `--potential` 提供。执行端依据结构与配置生成输入脚本。 `run.json` 记录输入、参数、版本、代码提交、Slurm 作业号、结束状态和产物。 `log.lammps` 为原生输出， `thermo.jsonl` 提取其热力学记录。 `trajectory.lammpstrj` 可从工作台 LAMMPS 轨迹入口读取。 `final.data` 和 `final.restart` 保存在本次运行。已由工作台提交的作业可在工作台取消与恢复。

V100 首次链路演练对应 Slurm 作业 `1033`，使用 LAMMPS 22 Jul 2025 Update 2。40 步合成 NVE 运行生成 5 帧原生轨迹和 5 条热力学记录。工作台从轨迹文件读回步号 0、10、20、30、40。批次目录为 `/home/v100/projects/catalysis-agent/jobs/md/20261118-lammps-run-01/`。

## 工作台提交与恢复

在 V100 启动工作台时传入 `--md-slurm-config /path/to/site.json`。受管模式仍使用项目登录、角色与审计策略。项目查看者可读取状态和产物。分析员和管理员可创建计划、人工确认、核对回执、取消作业和创建恢复计划。HTTP 进程保留原有出站限制。单独启动的本机调度进程仅接收固定的 Slurm 操作和项目计划标识。

场地配置样例使用已安装的 OpenMP 构建。CPU 数量和时限由每次计划指定，受场地上限约束。

```json
{
  "engine": "/absolute/path/to/lmp",
  "library_path": ["/absolute/path/to/lib"],
  "engine_args": ["-sf", "omp"],
  "cpu_partition": "cpu",
  "node": "v100",
  "memory": "4G",
  "max_cpus": 16,
  "max_minutes": 1440
}
```

`engine` 必填。其余字段可省略。内存省略时采用分区默认值。需提供 GPU 运行时，可配置 `gpu_engine`、`gpu_engine_args` 和 `gpu_partition`，且 GPU 资源申请限一张 V100。命令行参数、分区和执行环境均由场地配置提供。

创建计划时填入 `restart_every`，指定每段保存检查点的步数。先在 A6 核对资源与计算参数并人工确认。状态页显示 Slurm 状态、最近热力学步号、进度、已保存的检查点和输出文件。每个检查点由 LAMMPS 写完后原子发布。同一计算会保留各已发布检查点，磁盘需求随保存频率与体系大小增加。取消可能发生在第一个检查点生成之前。

调度回执丢失时使用 A6「查询回执」。核对只寻找原作业。V100 的 Slurm 未启用历史记账，控制器记录过期后可使用先前保存的回执。尚无法查明的提交保持待核对状态。要继续已经终止的计算，在工作台选择原作业的检查点并指定追加步数，创建新的 A6 计划，然后另行人工确认。恢复计划记录原计划、Slurm 作业号、检查点及其步号。`read_restart` 续接原步号与速度，工作台在新目录保存本次输出。请使用与生成检查点时兼容的 LAMMPS 构建。

API 采用普通项目作用域。下表所示为无项目前缀的路由。

| 请求 | 内容 |
| --- | --- |
| `POST /api/md-job/plan` | 与作业包相同的 multipart 来源字段，`options` 为 `{config, cpus, gpus, minutes, request_id}`。同一个 UUID 对应同一次创建请求 |
| `POST /api/plans/{id}/confirm` | `{digest, confirmed: true}` |
| `POST /api/plans/{id}/reconcile` | `{}`，只查询回执 |
| `GET /api/plans/{id}/status` | Slurm 状态、运行器状态、进度、检查点及产物下载链接 |
| `POST /api/plans/{id}/cancel` | `{confirmed: true}` |
| `POST /api/plans/{id}/restart` | `{checkpoint, steps, cpus, gpus, minutes}`，返回待确认的恢复计划 |
