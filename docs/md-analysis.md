# LAMMPS 热力学与原子组 MSD

工作台“科学分析与晶胞工具”提供“LAMMPS 热力学曲线”和“原子组 MSD 与扩散”。原始文件、参数、结果、代码版本和来源作业号随分析运行保存，支持从运行历史重新打开及下载原件。分析在 V100 内网执行；不提交求解器作业，不做数据质量门槛或哈希校验。

## 热力学曲线

上传原生 `log.lammps`，或现有 MD runner 生成的 `thermo.jsonl`。读取 thermo 输出表中的原始数值，默认展示温度、压力、势能和总能；展开“其他输出列与原始数值”选择其他列。保留各段采样，不做平滑或删点。

日志含 `units` 命令时直接读取；JSONL 等未标注单位的文件在界面选择 metal 或 real。metal 的时间/能量/压力为 ps/eV/bar，real 为 fs/(kcal/mol)/atm，长度均为 Å。曲线时间轴转为 ps；没有 Time 列时可填写 ps/step，否则使用步号。能量数值保持原日志定义，包含 LAMMPS thermo_modify norm 等运行设置的影响，不另行归一化。未知自定义列保留原名，单位显示未标注。

## 原子组 MSD

上传文本 dump，按首帧的原子 ID、类型或两者交集选择固定原子组；后续按 ID 跟踪，行顺序不影响计算。可选 x/y/z、xy/xz/yz 或 xyz，选择等效维数 d；未选方向不计入位移平方。

读取展开坐标 xu/yu/zu 或 xsu/ysu/zsu，或由坐标和 ix/iy/iz 镜像标记还原真实位移，支持斜晶胞。没有足够坐标信息时提示补充原件，不猜测跨周期次数。

时间取 ITEM: TIME 并换算 ps；轨迹未输出时间时填写 timestep_ps。显式填写步长时使用“步号差 × 步长”。零点为第一帧。拟合范围为相对首帧的 ps，包含端点。

MSD(t) = mean_i |r_i(t) − r_i(0) − drift(t)|²，属于单一起点估计。默认保留位移；选择扣除漂移时采用所选组质心位移（有质量信息）或等权平均位移（无质量信息），结果明确记录权重方式。高级 JSON 可用 masses_by_type 提供质量映射。MSD 对选中原子等权平均。

在所选窗口对 MSD = slope × t + intercept 做带截距线性拟合，D = slope / (2d)。报告 Å²/ps 和 m²/s（换算因子 1e-8），不将负斜率截断为零，也不以阈值拒绝结果。这里的 D 是指定窗口的拟合值；单起点短轨迹不自动解释为材料长期扩散系数。

## 配置契约

API 沿用项目作用域的 POST /api/runs，multipart 字段 file、kind、origin、options。
kind 为 md_thermo 或 md_msd。运行 operation 为 md.thermo 或 md.msd。
options 公共字段：unit_style（metal/real，可从文件读取）、timestep_ps、source_job_id（可选来源标签，非调度器查询）。
MSD 字段：atom_ids、atom_types（整数或十进制字符串数组）、axes、remove_drift、fit_start_ps、fit_end_ps、masses_by_type。
结果中的 rows 保留数值；thermo 含 columns/units/unit_style；MSD 含 selection/axes/dimension/time_source/time_origin/rows/fit。

输入缺少解析或运算必需的信息时返回明确错误。现有工程性文件读取大小限制沿用。原始上传不被覆写。系统既有内容标识用于存储定位，不对内容作重复哈希比对。

## 本次合成来源

复用 V100 作业 1033 的现存 log.lammps、thermo.jsonl 和 trajectory.lammpstrj。新开发和浏览器记录位于 jobs/md/20261118-curves-msd-01/，原始求解结果仍位于 jobs/md/20261118-lammps-run-01/results/run-1033/lammps/。本次不重跑 LAMMPS，不迁移 RVE/FEM，不重做 A1–A7。
