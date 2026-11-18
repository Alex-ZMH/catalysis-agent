# 导入 VASP 表面吸附研究

上传一个 ZIP。根目录放 UTF-8 编码的 `study.json`，体相、裸表面、每个吸附构型和每个气相参考各放一份完整的 `vasprun.xml`。同一物种可有多个位点。同一构型可包含多个吸附单元，也可以使用多种气相参考和分数系数。至少需要两个吸附构型和一个气相参考。

## study.json 示例

下例比较一个 O 和两个 O 的吸附构型，以 O₂ 为气相参考。原子数、能量、力、晶胞、采样和计算参数来自 XML。

```json
{
  "adsorbate_formula": {"O": 1},
  "bulk": {
    "structure_id": "bulk", "file": "bulk/vasprun.xml",
    "magnetic_state": "FM", "geometry_history": "relaxation",
    "protocol_evidence_id": "bulk-protocol"
  },
  "clean_slab": {
    "structure_id": "slab", "file": "slab/vasprun.xml",
    "magnetic_state": "FM", "geometry_history": "relaxation",
    "protocol_evidence_id": "slab-protocol",
    "bulk_structure_id": "bulk", "bulk_to_slab_atom_map_id": "bulk-map",
    "miller_indices": [1, 1, 0], "termination": "Fe",
    "fixed_layers_id": "fixed", "slab_thickness_angstrom": 8, "vacuum_angstrom": 18,
    "finite_size_check": {
      "evidence_id": "size", "thickness_effect_eV": 0.01,
      "vacuum_effect_eV": 0.005, "limit_eV": 0.02
    }
  },
  "configurations": [
    {
      "structure_id": "top", "site": "顶位", "file": "top/vasprun.xml",
      "magnetic_state": "FM", "geometry_history": "relaxation",
      "protocol_evidence_id": "top-protocol",
      "clean_structure_id": "slab", "clean_to_adsorbed_atom_map_id": "top-map",
      "fixed_layers_id": "fixed", "vacuum_angstrom": 18,
      "adsorbed_units": 1, "reference_coefficients": {"oxygen": 0.5}
    },
    {
      "structure_id": "bridge", "site": "桥位", "file": "bridge/vasprun.xml",
      "magnetic_state": "FM", "geometry_history": "relaxation",
      "protocol_evidence_id": "bridge-protocol",
      "clean_structure_id": "slab", "clean_to_adsorbed_atom_map_id": "bridge-map",
      "fixed_layers_id": "fixed", "vacuum_angstrom": 18,
      "adsorbed_units": 2, "reference_coefficients": {"oxygen": 1}
    }
  ],
  "gas_references": [
    {
      "structure_id": "oxygen", "file": "oxygen/vasprun.xml",
      "magnetic_state": "triplet", "geometry_history": "relaxation",
      "protocol_evidence_id": "oxygen-protocol",
      "isolation_check": {"evidence_id": "isolation", "effect_eV": 0.003, "limit_eV": 0.01}
    }
  ],
  "evidence": {
    "bulk-protocol": "evidence/bulk.md",
    "slab-protocol": "evidence/slab.md",
    "top-protocol": "evidence/top.md",
    "bridge-protocol": "evidence/bridge.md",
    "oxygen-protocol": "evidence/oxygen.md",
    "bulk-map": "evidence/bulk-map.json",
    "top-map": "evidence/top-map.json",
    "bridge-map": "evidence/bridge-map.json",
    "fixed": "evidence/fixed.json",
    "size": "evidence/size.md",
    "isolation": "evidence/isolation.md"
  }
}
```

逻辑 ID 使用 1 至 128 个 ASCII 字母、数字、下划线或连字符，首字符为字母或数字。每个证据 ID 对应唯一的非空 ZIP 文件。相同固定层协议应当复用同一个证据 ID。协议文件应记录数据来源、磁态判定和运行关系。原子映射文件应标明索引起点、体相到表面的超胞变换及表面到吸附结构的原子对应关系。有限尺寸及隔离测试应附比较体系、能量定义和实测差值。导入器检查证据存在、保留其原始字节并使用清单声明值。其科学真实性、原子映射内容和附加计算仍需审核。

`geometry_history: "relaxation"` 要求 XML 有 `NSW > 0` 和 `IBRION` 为 1、2 或 3。若上传的是从已弛豫结构重启的静态计算，填写 `"restart_from_relaxed"`，另加 `prior_relaxation_evidence_id`，其文件应记录前序弛豫的运行标识、收敛数据及重启结构与前序末态的对应证据。体相先于表面的链路依赖体相与表面映射及提交的研究记录，单次静态计算不能建立该链路。

## XML 口径和补充数据

- 读最后一个 `calculation` 的晶格、分数坐标、力和 **`energy/i[@name='e_fr_energy']`**。这是含展宽熵项的电子自由能口径。各成员统一使用这一项，单位为 eV，输出按每个吸附单元归一化。
- 从 `atominfo` 的原子和类型表交叉检查组成，读取 POTCAR 标题和价电子数。从展开参数和 INCAR 读取泛函、截断能、展宽、自旋、色散及 Dudarev DFT+U。这一版本支持每个元素一种 POTCAR 类型，使用 XML 标题判断势的一致性。相同标题的 POTCAR 内容差异须由提交者核实。仅支持无自定义偏移的 Gamma 或 Monkhorst–Pack 自动网格。气相要求单 Gamma 点。
- XML 中缺省的 `METAGGA`、`LSORBIT`、`LNONCOLLINEAR`、`ISPIN`、`LHFCALC`、`LDAU`、`IVDW`、`LUSE_VDW`、`ISMEAR`、`SIGMA` 分别使用未启用、关闭、关闭、1、关闭、关闭、0、关闭、1、0.2 的常规默认值。对 XML 缺失或空白的上述参数，也可在对应运行添加 `missing_parameters`，以 VASP 文本值补充，比如 `{"GGA":"PE","LSORBIT":"F"}`。此对象还接受缺失的 `GGA`、`ENCUT`、`NELECT`、`EDIFF`、`EDIFFG`、`NELM`、`NSW`、`IBRION`。补充值须由协议证据支持，有 XML 值时不能覆盖。
- 电子筛选取末两次 SCF 的 `e_fr_energy` 和 `e_wo_entrp` 两项能量变化的最大绝对值，与 `EDIFF` 比较。这是基于 XML 打印精度的代理量。若达到 `NELM`，且代理量仍超阈值，则标记未收敛。若达到 `NELM` 但代理量未超阈值，则标注达到电子迭代上限及收敛状态待定。末步缺少第二个 SCF 记录时，需在清单添上有协议文件支持的实测 `scf_residual_eV`。
- 最大自由力按各原子可移动方向上的力投影计算。优先读末步或初始结构的选择性弛豫标志。若 XML 均缺失，在清单填 `free_directions: "all"` 或按原子顺序提供三列布尔数组，并在协议材料中说明。负 `EDIFFG` 给出力阈值。非负 `EDIFFG` 需要另给有协议依据的 `force_limit_eV_per_angstrom`，作为本研究的独立力筛选。
- 结构坐标、逐晶格矢量长度、能量项、SCF 代理量来源和证据映射都写入详情。按所声明的参考可计算出吸附能时，数值写入 `result.json` 的 `observed_adsorption`，方法差异、化学计量和收敛情况并列记录。文件解析错误会在对应的输入记录上报。这里的吸附能是相对于所声明参考的能量差。

## UI 和本机预算

入口为 `packages.science.vasp.analyze(filename, content, options, origin, raw_id, register)`。默认 `options={}`。可用 `{"cell_limits_A":[40,40,50]}` 或 `{"cell_limits_A":{"c":45}}` 收紧上限。省略的轴使用 50 Å。导入检查全部运行的末态晶胞，包括真空所在的晶格矢量，超限记录实际长度、阈值和轴。导出结构沿用原晶胞。

下列环境变量由本机管理员配置，单位为 MiB 的变量使用整数。调整后新导入读取相应配置，与科学参数分开。

| 环境变量 | 默认值 | 约束对象 |
| --- | ---: | --- |
| `CATALYSIS_VASP_ZIP_MIB` | 64 | ZIP 上传字节数 |
| `CATALYSIS_VASP_MEMBER_MIB` | 128 | 单成员解压后的字节数 |
| `CATALYSIS_VASP_TOTAL_MIB` | 256 | ZIP 成员解压后的总字节数 |
| `CATALYSIS_VASP_XML_NODES` | 2000000 | 单份 XML 元素数 |

ZIP 最多 128 个条目，`study.json` 最多 256 KiB，XML 嵌套限制 64 层。只支持储存或 Deflate 压缩的普通 ZIP 文件。导入在内存中读取，拒绝危险路径、重复成员、符号链接、加密和 XML DTD。导入不访问网络或替 ZIP 提取文件。如上游另有上传限制，也需要允许相应文件大小。

`tests/test_vasp_import.py` 的 `demo()` 返回 `(filename, bytes, {})`。用 `origin="synthetic"` 演示。预期 `top` 为 −1.5 eV，`bridge` 为 −1.0 eV，另有未收敛的 `hollow` 和截断能不同的 `variant`。v1 内的 ID 和气相系数键为注册后的文件 ID。界面可按 `details.runs[*].structure_id` 找回逻辑标签、位点、原始文件与能量。

### 固定晶胞与缺失 SCF 列

有序晶格矢量任一分量的差超过 10⁻⁶ Å 时，构型附带晶格差异说明。

末两次 SCF 任一条缺少 `e_fr_energy` 或 `e_wo_entrp` 时，需用有全精度记录支持的 `scf_residual_eV`。在该运行现有的 `protocol_evidence_id` 所指文件中保存最后两次电子步的实测能量变化、运行标识及单位。残差填两种变化的最大绝对值。导入器不会使用 `e_0_energy` 或本征值代替缺失列。
