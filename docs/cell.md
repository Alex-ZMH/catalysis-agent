# Slab cell preflight

`packages.science.cell.check_cell(vectors, limits_A=None)` accepts the three
physical lattice vectors in angstroms, in a, b, c order. All components must be
finite and the cell must be numerically nonsingular. Each full Euclidean vector
length has an inclusive 50 Å cap. Supply a stricter positive scalar for all
axes, an ordered list [a, b, c], or a dictionary with any of the keys `a`, `b`, and `c`. Omitted axes retain
the default. Limits above 50 Å raise `ValueError`.

The result contains `lengths_A` and `limits_A` dictionaries keyed by axis,
`exceeded_axes` in lattice order, and the Boolean `within_limit`.

`plan_from_poscar(content, options)` accepts UTF-8 bytes for an existing
cleaved slab whose surface is spanned by a and b. Use these options:

| Option | Meaning |
| --- | --- |
| `repeats` | Three positive integer repeats in a, b, c order. Defaults to `[1, 1, 1]`. |
| `vacuum_A` | Positive total vacuum in angstroms along the surface normal. Omit it to keep the supplied cell before replication. |
| `limits_A` | Optional caps in the same format as `check_cell`. |

With vacuum replacement, the planner uses the largest gap between occupied
normal positions, including the periodic gap, as the vacuum. It unwraps the
slab across that cut, sets the normal period to the slab span plus the
requested vacuum, and centers the slab along the normal. It preserves c's
in-plane component and the Cartesian geometry of the unwrapped slab, modulo
periodic translations. The preflight checks the final full vector lengths,
including repeats, vacuum, and skew. The largest-gap rule assumes the caller
supplied an already cleaved slab with a single intended vacuum region.

The planner returns the cell check fields plus `repeats` and `vacuum_A`
(`None` when omitted), `atom_count`, `slab_thickness_A`, and
`actual_vacuum_A`. With c replication and the original vacuum retained,
the two geometry fields sum the slab spans and the vacuum gaps across copies.
A size-passing result also contains the candidate `poscar`
string and `atom_mapping` in output atom order. Each mapping entry gives the
zero-based `source_index` and the `image` triplet of the repeat relative to the
prepared base slab. Output uses scale 1 and Direct coordinates. Species blocks
and selective dynamics flags are retained. The flags are interpreted along
the output lattice directions by VASP.

A size-passing model above the `CATALYSIS_MAX_MODEL_ATOMS` deployment limit
raises `ValueError` before candidate generation. The limit defaults to 100,000
atoms and must be configured as a positive integer.

Malformed or unsupported inputs raise `ValueError`. The parser accepts
a right-handed lattice, explicit species labels, one positive scale factor,
Direct or Cartesian
coordinates, and optional Selective dynamics. Velocity blocks, coordinate
annotations, and alternative scale conventions are unsupported. Vacuum
replacement rejects tied largest gaps and c repeats above one because the
choice of a vacuum cut or the spacing between multiple slabs would be
ambiguous.

## 仪器用户操作说明

请上传已切好的表面 POSCAR，确认 a 和 b 位于表面内，晶胞为右手坐标系。
例如，输入 `{"repeats":[2,2,1],"vacuum_A":15,"limits_A":[40,40,50]}`，
即可沿 a、b 各复制两次，并将沿表面法向的真空总厚度设为 15 Å。
程序根据最大层间空隙确定原真空区，跨周期边界拼回 slab，并沿法向居中。
省略 `vacuum_A` 可保留原真空。替换真空时，c 方向重复数必须为 1。

`lengths_A` 是最终 a、b、c 三条晶格矢量的完整长度，包含扩胞、真空和倾斜
带来的影响。每轴上限最高为 50 Å。查看 `exceeded_axes` 可确定超限方向。
`slab_thickness_A` 是沿表面法向的原子层跨度，`actual_vacuum_A` 是实际
法向真空总厚度。保留原真空并沿 c 复制时，这两项分别累加各副本的跨度和真空。

尺寸合格且原子数未超部署上限时，返回可保存的 `poscar` 和逐原子的
`atom_mapping`。原子数上限默认 100,000，由管理员通过
`CATALYSIS_MAX_MODEL_ATOMS` 设置。左手晶胞、并列最大真空间隙或超过
原子数上限时，程序会给出错误。
