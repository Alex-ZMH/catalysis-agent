# 导入 LAMMPS 文本轨迹

提交原始 LAMMPS `dump custom` 或 `dump atom` 文本，例如 `run.lammpstrj`。导入范围为单条轨迹。dump 中的 timestep 必须非负且严格递增，重启后重置步号的段需单独导入。每帧须包含原子数、`BOX BOUNDS`、`ATOMS` 列名和对应数据。原子 ID 必须为正整数且在帧内唯一。不同帧可以改变原子顺序、数量和 ID。

```python
result, details = read_import(
    "run.lammpstrj", dump_bytes, {"length_unit": "angstrom"}, "raw_dump",
    reference=("reference.json", reference_bytes, "raw_reference"),
)
```

## 晶胞与坐标

支持正交晶胞和带 `xy xz yz` 的 restricted triclinic 晶胞。解析器根据带符号的倾斜量从包围盒还原真实原点和按 a、b、c 排列的基矢。每帧单独读取边界标志。只有 `pp` 对应周期轴，`f`、`s`、`m` 组成的边界为非周期，具体标志保存在 `details.frame_checks[].boundary_flags`。

坐标列与其他原子列可以任意排列。默认按第一个完整三元组选择，优先级为 `x y z`、`xu yu zu`、`xs ys zs`、`xsu ysu zsu`。文件同时输出多套坐标时，可以设置 `coordinate_columns` 为 `x`、`xu`、`xs` 或 `xsu`，指定全程采用的一套。缩放坐标按原点加基矢线性组合转换成笛卡尔坐标。所有坐标保留 dump 指定的周期镜像，即使落在晶胞外。`x` 和 `xs` 标记为 `wrapped`，`xu` 和 `xsu` 标记为 `unwrapped`。同一次导入的模式必须一致。

## 单位与时间

提供 `length_unit`，或者启用 LAMMPS 的 `dump_modify ... units yes`。长度数值采用原始单位，显式单位标签保留。已知 `ITEM: UNITS` 时，冲突的长度或时间单位会报错。与 dump 单位样式或独立参考比较时，单位标签区分大小写，例如 `Mm` 和 `mm` 不同。已知别名按同一单位比较，包括 `angstrom`、`Å`、`ångström`（接受大小写变体），以及微米的 `um`、`µm`、`μm` 和微秒的 `us`、`µs`、`μs`。

| LAMMPS 单位样式 | 长度 | 时间 |
| --- | --- | --- |
| `lj` | `1` | `1` |
| `real` | `angstrom` | `fs` |
| `metal` | `angstrom` | `ps` |
| `si` | `m` | `s` |
| `cgs` | `cm` | `s` |
| `electron` | `bohr` | `fs` |
| `micro` | `um` | `us` |
| `nano` | `nm` | `ns` |

物理时间由以下规则确定。

- 使用 `dt` 时，须提供正值和 `time_unit`，也可以由 `ITEM: UNITS` 确定时间单位。可选的 `time_origin` 和 `step_origin` 默认均为 0。映射为 `time_origin + (timestep - step_origin) * dt`。
- 使用 `dump_modify ... time yes` 时，每帧的 `ITEM: TIME` 位于 `ITEM: TIMESTEP` 之前。配合已知的时间单位，该流保存单调递增的显式时间。不要同时传 `dt`。
- 无可用时间映射时采用 `time.mode = "unknown"`，包括文件有 `ITEM: TIME` 但时间单位未知的情况。仅凭步号间隔或单位样式无法确定物理时间。

## 独立参考校验

参考是单独上传的原始 JSON，并使用独立 artifact ID。以下例子展示字段形状。实际参考文件须包含 dump 的全部帧与每帧全部原子。

```json
{
  "length_unit": "angstrom",
  "coordinate_mode": "wrapped",
  "absolute_tolerance": 0.000001,
  "frames": [
    {
      "timestep": 0,
      "cell": {
        "origin": [1, 0, 3],
        "vectors": [[9, 0, 0], [-2, 8, 0], [1, -1, 6]],
        "periodic": [true, false, true]
      },
      "atoms": [{"id": 7, "position": [5.5, 1.5, 6]}]
    }
  ]
}
```

参考帧按 timestep 匹配，原子按 ID 匹配，顺序不限。绝对容差以共同长度单位表示，逐分量应用于笛卡尔坐标、原点和基矢。周期性严格匹配。如果还需核对具体边界类型，可在参考的 `cell` 内提供可选的 `boundary_flags`，例如 `["pp", "ff", "pp"]`。原子坐标不符时，错误标明 step、ID 和轴。

有参考且全部匹配时，`details.reference_verified` 为 `true`，并记录 `reference_artifact_id`。每帧报告 `timestep`、`atom_count`、原子坐标的 `max_abs_error` 和晶胞的 `max_cell_abs_error`。未提供参考时，`reference_verified` 为 `false`，`max_abs_error` 为 `null`。

## 读取上限

以下选项接受正整数。服务接收上传时可以另有上限。

| 选项 | 默认值 |
| --- | ---: |
| `max_bytes` | 33,554,432 |
| `max_line_bytes` | 65,536 |
| `max_frames` | 10,000 |
| `max_atoms_per_frame` | 100,000 |
| `max_total_atoms` | 200,000 |
| `max_reference_bytes` | 33,554,432 |

当前范围为原生文本轨迹。压缩、二进制、general triclinic、thermo 时间序列和通过 image flags 重建展开坐标均不受支持。
