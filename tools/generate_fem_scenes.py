"""Generate two offline illustrations of synthetic scalar and directional fields."""

from math import cos, exp, hypot, sin
import json
from pathlib import Path
from xml.etree import ElementTree as ET


PANELS = (
    ("stirred", 24, "搅拌釜", "釜内循环", (
        ((35, 65), (198, 65), (198, 169), (194, 185), (182, 200),
         (163, 210), (70, 210), (51, 200), (39, 185), (35, 169)),
    )),
    ("bed", 280, "底部布气的流化床", "气体由布气板进入", (
        ((67, 58), (166, 58), (166, 198), (67, 198)),
    )),
    ("exchanger", 536, "换热器", "隔壁两侧逆向流动", (
        ((18, 77), (215, 77), (215, 130), (18, 130)),
        ((18, 140), (215, 140), (215, 193), (18, 193)),
    )),
)
PALETTE = ("#163657", "#1d5683", "#168aa9", "#45cfda", "#b9f0e8", "#ffd090")


def cross(a, b, p):
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])


def edges(polygon):
    return zip(polygon, polygon[1:] + polygon[:1])


def area(polygon):
    return sum(cross((0, 0), a, b) for a, b in edges(polygon)) / 2


def clip(polygon, domain):
    """Intersect a lattice triangle with one convex fluid domain."""
    for a, b in edges(domain):
        clipped = []
        for p, q in edges(polygon):
            dp, dq = cross(a, b, p), cross(a, b, q)
            if dp >= 0:
                clipped.append(p)
            if (dp < 0 < dq) or (dq < 0 < dp):
                t = dp / (dp - dq)
                clipped.append((p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])))
        polygon = clipped
    return polygon


def mesh(domain):
    def node(column, row):
        return (column * 14 + 7 * (row % 2), row * 12)

    triangles = []
    for row in range(18):
        for column in range(16):
            a, b = node(column, row), node(column + 1, row)
            c, d = node(column, row + 1), node(column + 1, row + 1)
            cells = ((a, b, c), (b, d, c)) if row % 2 == 0 else ((a, b, d), (a, d, c))
            for cell in cells:
                polygon = clip(cell, domain)
                for index in range(1, len(polygon) - 1):
                    triangle = (polygon[0], polygon[index], polygon[index + 1])
                    if area(triangle) > 1e-8:
                        triangles.append(triangle)
    if abs(sum(map(area, triangles)) - area(domain)) > 1e-7:
        raise ValueError("Triangle mesh does not cover its domain")
    if any(cross(a, b, p) < -1e-7 for triangle in triangles for p in triangle for a, b in edges(domain)):
        raise ValueError("Triangle extends beyond its domain")
    return triangles


def field(device, channel, x, y):
    """Return arbitrary continuous temperature and a planar velocity vector."""
    if device == "stirred":
        u, v = (x - 117) / 82, (y - 135) / 72
        swirl = exp(-1.4 * (u * u + v * v))
        heat = 0.66 * exp(-3 * ((u + .45) ** 2 + (v - .52) ** 2)) + .27 * (v + 1)
        return heat, (-v * swirl, u * swirl)
    if device == "bed":
        u, v = (x - 117) / 50, (198 - y) / 140
        plume = exp(-3 * (u - .24 * sin(5 * v)) ** 2)
        return .58 * (1 - v) + .42 * plume * v, (.17 * sin(7 * v) * plume, -.14 - .76 * plume * (1 - .44 * v))
    u = (x - 18) / 197
    center = 103.5 if channel == 0 else 166.5
    v = (y - center) / 26.5
    heat = .93 - .47 * u + .072 * v if channel == 0 else .51 - .38 * u - .072 * v
    speed = (1 - v * v) * (.85 - .11 * cos(5 * u))
    return heat, (speed if channel == 0 else -.78 * speed, 0)


def color(value):
    position = max(0, min(1, value)) * (len(PALETTE) - 1)
    index = min(int(position), len(PALETTE) - 2)
    left, right = (bytes.fromhex(rgb[1:]) for rgb in PALETTE[index:index + 2])
    fraction = position - index
    return "#" + bytes(round(a + fraction * (b - a)) for a, b in zip(left, right)).hex()


def points(polygon):
    return " ".join(f"{x:.6f},{y:.6f}" for x, y in polygon)


def vectors(device, channel, domain):
    for y in range(85, 200, 22):
        for x in range(33, 207, 27):
            if any(cross(a, b, (x, y)) < 11 * hypot(b[0] - a[0], b[1] - a[1]) for a, b in edges(domain)):
                continue
            _, (u, v) = field(device, channel, x, y)
            speed = hypot(u, v)
            if speed < .075:
                continue
            dx, dy = 5.5 * u / speed, 5.5 * v / speed
            yield f'<path d="M{x-dx:.2f},{y-dy:.2f}L{x+dx:.2f},{y+dy:.2f}" marker-end="url(#vector)"/>'


def hardware(device):
    if device == "stirred":
        return '<rect x="107" y="43" width="20" height="13" rx="3"/><path d="M117 56V65M29 64H204M57 205L52 222M176 205L181 222"/>'
    if device == "bed":
        holes = "".join(f'<circle cx="{x}" cy="199" r="2" fill="#ffd090" stroke="none"/>' for x in range(74, 165, 11))
        return f'<path d="M67 198V206L116.5 220 166 206V198Z"/><path d="M116.5 229V218" stroke="#ffd090" marker-end="url(#feed)"/>{holes}'
    return '<path d="M18 130H215V140H18Z"/><path d="M26 135H207" stroke="#a6d4df" stroke-dasharray="3 4"/>'


def render(mode, panels):
    velocity = mode == "velocity"
    title = "无量纲局部相对速度幅值" if velocity else "无量纲局部相对温度"
    stops = "".join(f'<stop offset="{i / (len(PALETTE) - 1):.3f}" stop-color="{rgb}"/>' for i, rgb in enumerate(PALETTE))
    out = [f'''<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400" viewBox="0 0 800 400" role="img" aria-labelledby="title desc">
  <title id="title">{title}</title>
  <desc id="desc">三种设备的裁切三角网格与解析构造场。色标为各设备独立归一化的无量纲值。换热器上下通道逆向流动。</desc>
  <defs>
    <linearGradient id="bg" x2="0" y2="1"><stop stop-color="#142f47"/><stop offset="1" stop-color="#071625"/></linearGradient>
    <linearGradient id="scale">{stops}</linearGradient>
    <marker id="vector" markerUnits="userSpaceOnUse" markerWidth="5" markerHeight="6" refX="4.4" refY="3" orient="auto"><path d="M0 0L5 3 0 6Z" fill="#f1fcff"/></marker>
    <marker id="feed" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0L6 3 0 6Z" fill="#ffd090"/></marker>
  </defs>
  <rect width="800" height="400" rx="20" fill="url(#bg)"/>
  <g font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" fill="#e2f9fd">
    <text x="24" y="43" font-size="25" font-weight="700">{title}</text>
    <text x="776" y="41" text-anchor="end" font-size="12" fill="#ffd090">SYNTHETIC · 非求解结果，各设备独立归一化</text>''']
    for device, offset, label, note, domains in panels:
        cells = []
        for channel, (domain, triangles) in enumerate(domains):
            for triangle in triangles:
                x, y = (sum(coordinates) / 3 for coordinates in zip(*triangle))
                heat, direction = field(device, channel, x, y)
                cells.append((triangle, hypot(*direction) if velocity else heat))
        values = [value for _, value in cells]
        low, span = min(values), max(values) - min(values)
        out.append(f'''    <g id="{device}" transform="translate({offset} 65)">
      <rect width="240" height="245" rx="11" fill="#0c2337" stroke="#31596f"/>
      <text x="120" y="26" text-anchor="middle" font-size="16" font-weight="700">{label}</text>
      <g stroke="#0a2236" stroke-opacity=".42" stroke-width=".55">''')
        out.extend(f'        <polygon points="{points(triangle)}" fill="{color((value-low)/span)}"/>' for triangle, value in cells)
        out.append('      </g><g fill="none" stroke="#a2ddeb" stroke-width="1.25">')
        out.extend(f'        <polygon points="{points(domain)}"/>' for domain, _ in domains)
        out.append(f'      </g><g fill="#24445a" stroke="#82bbce" stroke-width="1.3">{hardware(device)}</g>')
        if velocity:
            out.append('      <g fill="none" stroke="#f1fcff" stroke-width="1.15" opacity=".9">')
            for channel, (domain, _) in enumerate(domains):
                out.extend(vectors(device, channel, domain))
            out.append('      </g>')
        if device == "exchanger":
            out.append('      <g font-size="11.5" fill="#d9faff"><text x="18" y="68">上通道 →</text><text x="215" y="210" text-anchor="end">← 下通道</text></g>')
        out.append(f'      <text x="120" y="237" text-anchor="middle" font-size="11.5" fill="#aed9e7">{note}</text>\n    </g>')
    out.append('''    <rect x="170" y="336" width="460" height="12" rx="4" fill="url(#scale)" stroke="#77a6b7" stroke-width=".65"/>
    <g font-size="12" text-anchor="middle" fill="#bfdde7">
      <text x="170" y="367">0</text><text x="400" y="367">0.5</text><text x="630" y="367">1</text>
      <text x="400" y="389">无量纲色标 · 解析场在三角单元重心采样</text>
    </g>
  </g>
</svg>
''')
    return "\n".join(out)


def render_detail(panel, mode, group, defs):
    device, _, label, note, domains = panel
    velocity = mode == "velocity"
    variable = "速度幅值" if velocity else "温度"
    sample_start, sample_end, trace = {
        "stirred": ((38, 153), (194, 153), "穿过釜体的水平截线"),
        "bed": ((116, 194), (116, 60), "从分布板向上的床轴线"),
        "exchanger": ((20, 102), (212, 102), "上通道的流向中心线"),
    }[device]

    def scalar(channel, position):
        heat, direction = field(device, channel, *position)
        return hypot(*direction) if velocity else heat

    values = [scalar(channel, [sum(axis) / 3 for axis in zip(*triangle)])
              for channel, (_, triangles) in enumerate(domains) for triangle in triangles]
    low, high = min(values), max(values)
    profile = []
    for step in range(41):
        fraction = step / 40
        point = [start + fraction * (end - start) for start, end in zip(sample_start, sample_end)]
        profile.append(round(min(1, max(0, (scalar(0, point) - low) / (high - low))), 5))
    start_x, start_y = sample_start
    end_x, end_y = sample_end
    group.set("transform", "translate(10 6)")
    title = f"{label} · {variable}场"
    field_key = "箭头 · 局部流向" if velocity else "色带 · 相对冷热"
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="520" height="256" viewBox="0 0 520 256" role="img" aria-label="{title}，沿 A 至 B 取样">
{ET.tostring(defs, encoding="unicode")}
<rect width="520" height="256" fill="#0b1823"/>
<g font-family="Microsoft YaHei,sans-serif" fill="#dcebf2">{ET.tostring(group, encoding="unicode")}
<g transform="translate(10 6)" font-size="12" font-weight="700" fill="white" stroke="#102737" stroke-width="2" paint-order="stroke">
<path d="M{start_x} {start_y}L{end_x} {end_y}" fill="none" stroke="white" stroke-width="1.2" stroke-dasharray="4 3"/>
<text x="{start_x+2}" y="{start_y-4}">A</text><text x="{end_x-8}" y="{end_y-5}">B</text></g>
<g transform="translate(266 0)"><text y="48" fill="#9de8f5" font-size="10" letter-spacing="2">SYNTHETIC FIELD</text>
<text y="79" font-size="22">{variable}场</text><text y="109" font-size="13">{field_key}</text>
<rect y="123" width="208" height="7" fill="url(#scale)"/><g font-size="11"><text y="149">低 · 0</text><text x="208" y="149" text-anchor="end">1 · 高</text></g>
<text y="179" font-size="13">A → B　{trace}</text><text y="203" font-size="12" fill="#b0c4d0">以本设备场值范围归一化</text>
<text y="226" font-size="12" fill="#b0c4d0">示意网格，非实际求解</text></g></g></svg>''', profile


def main():
    panels = [
        (device, offset, label, note, [(domain, mesh(domain)) for domain in domains])
        for device, offset, label, note, domains in PANELS
    ]
    directory = Path(__file__).resolve().parents[1] / "public" / "scenes"
    profiles = {}
    ET.register_namespace("", "http://www.w3.org/2000/svg")
    for mode in ("temperature", "velocity"):
        svg = render(mode, panels)
        root = ET.fromstring(svg)
        ids = {element.attrib["id"] for element in root.iter() if "id" in element.attrib}
        for element in root.iter():
            for value in element.attrib.values():
                if value.startswith("url(") and (not value.startswith("url(#") or value[5:-1] not in ids):
                    raise ValueError(f"Unresolved SVG reference: {value}")
        target = directory / f"fem-{mode}.svg"
        target.write_text(svg, encoding="utf-8", newline="\n")
        print(target)
        for panel in panels:
            device = panel[0]
            detail, series = render_detail(panel, mode, root.find(f".//*[@id='{device}']"), root.find("{*}defs"))
            (directory / f"field-{device}-{mode}.svg").write_text(detail, encoding="utf-8")
            profiles.setdefault(device, {})[mode] = series
    (directory.parents[1] / "field-curves.js").write_text(
        "window.CatalysisProfiles = " + json.dumps(profiles, separators=(",", ":")) + ";\n", encoding="utf-8")


if __name__ == "__main__":
    main()
