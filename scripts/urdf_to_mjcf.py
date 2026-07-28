"""
Generate or update a Lumos MJCF XML from the matching URDF.

The converter intentionally uses an existing MJCF file as the template so
MuJoCo-only sections such as default, floor/light, actuators, sensors, sites,
and visual materials are preserved.
"""
from __future__ import annotations

import argparse
import math
import os
import re
import xml.etree.ElementTree as ET
from pathlib import Path


def _nums(text: str | None, default: str = "0 0 0") -> list[float]:
    return [float(x) for x in (text or default).split()]


def _fmt_num(value: float) -> str:
    if abs(value) < 1e-12:
        value = 0.0
    return f"{value:.10g}"


def _fmt(values: list[float] | tuple[float, ...]) -> str:
    return " ".join(_fmt_num(v) for v in values)


def _identity_rpy(values: list[float]) -> bool:
    return all(abs(v) < 1e-12 for v in values)


def _rpy_to_quat(rpy: list[float]) -> list[float]:
    roll, pitch, yaw = rpy
    cr = math.cos(roll * 0.5)
    sr = math.sin(roll * 0.5)
    cp = math.cos(pitch * 0.5)
    sp = math.sin(pitch * 0.5)
    cy = math.cos(yaw * 0.5)
    sy = math.sin(yaw * 0.5)
    return [
        cr * cp * cy + sr * sp * sy,
        sr * cp * cy - cr * sp * sy,
        cr * sp * cy + sr * cp * sy,
        cr * cp * sy - sr * sp * cy,
    ]


def _normalize_quat(q: list[float]) -> list[float]:
    mag = math.sqrt(sum(x * x for x in q))
    if mag <= 0:
        return [1.0, 0.0, 0.0, 0.0]
    q = [x / mag for x in q]
    if q[0] < 0:
        q = [-x for x in q]
    return q


def _jacobi_eigen_symmetric(matrix: list[list[float]]) -> tuple[list[float], list[list[float]]]:
    a = [row[:] for row in matrix]
    v = [[1.0 if i == j else 0.0 for j in range(3)] for i in range(3)]

    for _ in range(50):
        p, q = 0, 1
        max_val = abs(a[p][q])
        for i in range(3):
            for j in range(i + 1, 3):
                if abs(a[i][j]) > max_val:
                    max_val = abs(a[i][j])
                    p, q = i, j
        if max_val < 1e-15:
            break

        if abs(a[p][p] - a[q][q]) < 1e-15:
            angle = math.pi / 4
        else:
            angle = 0.5 * math.atan2(2 * a[p][q], a[q][q] - a[p][p])

        c = math.cos(angle)
        s = math.sin(angle)
        app = c * c * a[p][p] - 2 * s * c * a[p][q] + s * s * a[q][q]
        aqq = s * s * a[p][p] + 2 * s * c * a[p][q] + c * c * a[q][q]
        a[p][p] = app
        a[q][q] = aqq
        a[p][q] = 0.0
        a[q][p] = 0.0

        for k in range(3):
            if k in (p, q):
                continue
            akp = c * a[k][p] - s * a[k][q]
            akq = s * a[k][p] + c * a[k][q]
            a[k][p] = a[p][k] = akp
            a[k][q] = a[q][k] = akq

        for k in range(3):
            vkp = c * v[k][p] - s * v[k][q]
            vkq = s * v[k][p] + c * v[k][q]
            v[k][p] = vkp
            v[k][q] = vkq

    values = [a[i][i] for i in range(3)]
    order = sorted(range(3), key=lambda idx: values[idx], reverse=True)
    values = [values[i] for i in order]
    vectors = [[v[row][col] for col in order] for row in range(3)]
    return values, vectors


def _matrix_to_quat(m: list[list[float]]) -> list[float]:
    trace = m[0][0] + m[1][1] + m[2][2]
    if trace > 0:
        s = math.sqrt(trace + 1.0) * 2
        return _normalize_quat([
            0.25 * s,
            (m[2][1] - m[1][2]) / s,
            (m[0][2] - m[2][0]) / s,
            (m[1][0] - m[0][1]) / s,
        ])
    if m[0][0] > m[1][1] and m[0][0] > m[2][2]:
        s = math.sqrt(1.0 + m[0][0] - m[1][1] - m[2][2]) * 2
        return _normalize_quat([
            (m[2][1] - m[1][2]) / s,
            0.25 * s,
            (m[0][1] + m[1][0]) / s,
            (m[0][2] + m[2][0]) / s,
        ])
    if m[1][1] > m[2][2]:
        s = math.sqrt(1.0 + m[1][1] - m[0][0] - m[2][2]) * 2
        return _normalize_quat([
            (m[0][2] - m[2][0]) / s,
            (m[0][1] + m[1][0]) / s,
            0.25 * s,
            (m[1][2] + m[2][1]) / s,
        ])
    s = math.sqrt(1.0 + m[2][2] - m[0][0] - m[1][1]) * 2
    return _normalize_quat([
        (m[1][0] - m[0][1]) / s,
        (m[0][2] + m[2][0]) / s,
        (m[1][2] + m[2][1]) / s,
        0.25 * s,
    ])


def _det3(m: list[list[float]]) -> float:
    return (
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    )


def _right_handed_axes(axes: list[list[float]]) -> list[list[float]]:
    axes = [row[:] for row in axes]
    if _det3(axes) < 0:
        for row in axes:
            row[2] *= -1
    return axes


def _inertial_to_mjcf(inertial_el: ET.Element) -> dict[str, str] | None:
    if inertial_el is None:
        return None

    origin = inertial_el.find("origin")
    mass = inertial_el.find("mass")
    inertia = inertial_el.find("inertia")
    if mass is None or inertia is None:
        return None

    matrix = [
        [float(inertia.get("ixx", "0")), float(inertia.get("ixy", "0")), float(inertia.get("ixz", "0"))],
        [float(inertia.get("ixy", "0")), float(inertia.get("iyy", "0")), float(inertia.get("iyz", "0"))],
        [float(inertia.get("ixz", "0")), float(inertia.get("iyz", "0")), float(inertia.get("izz", "0"))],
    ]
    diag, axes = _jacobi_eigen_symmetric(matrix)
    axes = _right_handed_axes(axes)
    return {
        "pos": _fmt(_nums(origin.get("xyz") if origin is not None else None)),
        "quat": _fmt(_matrix_to_quat(axes)),
        "mass": mass.get("value", "0"),
        "diaginertia": _fmt(diag),
    }


def _parse_urdf(path: Path) -> dict:
    root = ET.parse(path).getroot()
    links: dict[str, dict] = {}
    joints: dict[str, dict] = {}
    child_joint: dict[str, str] = {}

    for link_el in root.findall("link"):
        name = link_el.get("name")
        if not name:
            continue
        visuals = []
        for visual in link_el.findall("visual"):
            geometry = visual.find("geometry")
            mesh = geometry.find("mesh") if geometry is not None else None
            if mesh is None:
                continue
            material = visual.find("material")
            color = material.find("color") if material is not None else None
            visuals.append({
                "mesh": mesh.get("filename", ""),
                "rgba": color.get("rgba", "1 1 1 1") if color is not None else "1 1 1 1",
            })

        collisions = []
        for col in link_el.findall("collision"):
            origin = col.find("origin")
            geometry = col.find("geometry")
            if geometry is None:
                continue
            shape = None
            attrs = {}
            for candidate in ("box", "cylinder", "sphere", "mesh"):
                el = geometry.find(candidate)
                if el is not None:
                    shape = candidate
                    attrs = dict(el.attrib)
                    break
            if not shape:
                continue
            collisions.append({
                "origin": {
                    "xyz": _nums(origin.get("xyz") if origin is not None else None),
                    "rpy": _nums(origin.get("rpy") if origin is not None else None),
                },
                "shape": shape,
                "attrs": attrs,
            })

        links[name] = {
            "inertial": _inertial_to_mjcf(link_el.find("inertial")),
            "visuals": visuals,
            "collisions": collisions,
        }

    for joint_el in root.findall("joint"):
        name = joint_el.get("name")
        if not name:
            continue
        child = joint_el.find("child")
        parent = joint_el.find("parent")
        origin = joint_el.find("origin")
        axis = joint_el.find("axis")
        limit = joint_el.find("limit")
        child_name = child.get("link") if child is not None else None
        joints[name] = {
            "type": joint_el.get("type", "fixed"),
            "parent": parent.get("link") if parent is not None else None,
            "child": child_name,
            "origin": {
                "xyz": _nums(origin.get("xyz") if origin is not None else None),
                "rpy": _nums(origin.get("rpy") if origin is not None else None),
            },
            "axis": _nums(axis.get("xyz") if axis is not None else "0 0 1"),
            "limit": dict(limit.attrib) if limit is not None else {},
        }
        if child_name:
            child_joint[child_name] = name

    return {"name": root.get("name", path.stem), "links": links, "joints": joints, "child_joint": child_joint}


def _is_visual_geom(geom: ET.Element) -> bool:
    return geom.get("mesh") is not None or geom.get("group") in {"1", "2"}


def _remove_generated_collision_geoms(body: ET.Element) -> None:
    for geom in list(body.findall("geom")):
        if _is_visual_geom(geom):
            continue
        body.remove(geom)


def _collision_to_geom(col: dict) -> ET.Element:
    geom = ET.Element("geom")
    geom.set("rgba", "1 1 1 1")
    xyz = col["origin"]["xyz"]
    rpy = col["origin"]["rpy"]
    if any(abs(v) > 1e-12 for v in xyz):
        geom.set("pos", _fmt(xyz))
    if not _identity_rpy(rpy):
        geom.set("quat", _fmt(_rpy_to_quat(rpy)))

    shape = col["shape"]
    attrs = col["attrs"]
    if shape == "box":
        size = [v * 0.5 for v in _nums(attrs.get("size"))]
        geom.set("size", _fmt(size))
        geom.set("type", "box")
    elif shape == "cylinder":
        geom.set("size", _fmt([float(attrs.get("radius", "0")), float(attrs.get("length", "0")) * 0.5]))
        geom.set("type", "cylinder")
    elif shape == "sphere":
        geom.set("size", _fmt([float(attrs.get("radius", "0"))]))
    elif shape == "mesh":
        filename = attrs.get("filename", "")
        geom.set("type", "mesh")
        geom.set("mesh", Path(filename).stem)
    return geom


def _first_direct_body(body: ET.Element, name: str) -> ET.Element | None:
    for child in body.findall("body"):
        if child.get("name") == name:
            return child
    return None


def _find_body(root: ET.Element, name: str) -> ET.Element | None:
    for body in root.findall(".//body"):
        if body.get("name") == name:
            return body
    return None


def _remove_missing_bodies(body: ET.Element, link_names: set[str]) -> None:
    for child in list(body.findall("body")):
        if child.get("name") not in link_names:
            body.remove(child)
        else:
            _remove_missing_bodies(child, link_names)


def _update_mesh_assets(mjcf_root: ET.Element, urdf: dict) -> None:
    asset = mjcf_root.find("asset")
    if asset is None:
        asset = ET.SubElement(mjcf_root, "asset")

    meshes = {mesh.get("name"): mesh for mesh in asset.findall("mesh") if mesh.get("name")}
    for link_name, link in urdf["links"].items():
        if not link["visuals"]:
            continue
        mesh_file = Path(link["visuals"][0]["mesh"]).name
        if not mesh_file:
            continue
        mesh = meshes.get(link_name)
        if mesh is None:
            mesh = ET.SubElement(asset, "mesh")
            mesh.set("name", link_name)
            meshes[link_name] = mesh
        mesh.set("file", mesh_file)


def _update_body(body: ET.Element, link_name: str, urdf: dict, is_root: bool = False) -> None:
    link = urdf["links"].get(link_name)
    if not link:
        return

    joint_name = urdf["child_joint"].get(link_name)
    if joint_name and not is_root:
        joint = urdf["joints"][joint_name]
        body.set("pos", _fmt(joint["origin"]["xyz"]))
        rpy = joint["origin"]["rpy"]
        if _identity_rpy(rpy):
            body.attrib.pop("quat", None)
        else:
            body.set("quat", _fmt(_rpy_to_quat(rpy)))

    inertial = body.find("inertial")
    inertial_data = link["inertial"]
    if inertial_data:
        if inertial is None:
            inertial = ET.Element("inertial")
            body.insert(0, inertial)
        inertial.attrib.clear()
        inertial.attrib.update(inertial_data)

    joint_el = body.find("joint")
    if joint_name and joint_el is not None:
        joint = urdf["joints"][joint_name]
        joint_el.set("name", joint_name)
        joint_el.set("pos", "0 0 0")
        joint_el.set("axis", _fmt(joint["axis"]))
        limit = joint["limit"]
        if "lower" in limit and "upper" in limit:
            joint_el.set("range", f"{limit['lower']} {limit['upper']}")
        if "effort" in limit:
            effort = limit["effort"]
            joint_el.set("actuatorfrcrange", f"-{effort} {effort}")

    visual_geoms = [geom for geom in body.findall("geom") if _is_visual_geom(geom)]
    visuals = link["visuals"]
    for idx, visual in enumerate(visuals):
        geom = visual_geoms[idx] if idx < len(visual_geoms) else None
        if geom is None:
            geom = ET.Element("geom")
            insert_at = 0
            for pos, child in enumerate(list(body)):
                if child.tag in {"inertial", "joint", "site"}:
                    insert_at = pos + 1
            body.insert(insert_at, geom)
        geom.set("type", "mesh")
        geom.set("contype", "0")
        geom.set("conaffinity", "0")
        geom.set("group", geom.get("group", "1"))
        geom.set("density", "0")
        geom.set("rgba", visual["rgba"])
        geom.set("mesh", link_name if idx == 0 else Path(visual["mesh"]).stem)

    _remove_generated_collision_geoms(body)
    insert_after = -1
    children = list(body)
    for idx, child in enumerate(children):
        if child.tag in {"inertial", "joint", "site", "geom"}:
            insert_after = idx
    for offset, col in enumerate(link["collisions"], start=1):
        body.insert(insert_after + offset, _collision_to_geom(col))


def _filter_actuators_and_sensors(root: ET.Element, joint_names: set[str]) -> None:
    actuator = root.find("actuator")
    if actuator is not None:
        for motor in list(actuator):
            joint = motor.get("joint")
            if joint and joint not in joint_names:
                actuator.remove(motor)

    sensor = root.find("sensor")
    if sensor is not None:
        for item in list(sensor):
            joint = item.get("joint")
            if joint and joint not in joint_names:
                sensor.remove(item)


def _indent(elem: ET.Element, level: int = 0) -> None:
    space = "  "
    indent = "\n" + level * space
    if len(elem):
        if not elem.text or not elem.text.strip():
            elem.text = indent + space
        for child in elem:
            _indent(child, level + 1)
        if not child.tail or not child.tail.strip():
            child.tail = indent
    if level and (not elem.tail or not elem.tail.strip()):
        elem.tail = indent


def generate_mjcf(urdf_path: Path, template_xml_path: Path, output_xml_path: Path, model_name: str | None = None) -> dict:
    urdf = _parse_urdf(urdf_path)
    tree = ET.parse(template_xml_path)
    root = tree.getroot()

    model = model_name
    if model is None and template_xml_path.resolve() != output_xml_path.resolve():
        model = urdf_path.stem
    if model is not None:
        root.set("model", model)
        for default in root.findall(".//default"):
            if default.get("class") and re.match(r"nix2-\d", default.get("class", "")):
                default.set("class", model)
        for body in root.findall(".//body"):
            if body.get("childclass") and re.match(r"nix2-\d", body.get("childclass", "")):
                body.set("childclass", model)

    _update_mesh_assets(root, urdf)

    worldbody = root.find("worldbody")
    if worldbody is None:
        raise ValueError("template XML missing worldbody")
    root_body = _first_direct_body(worldbody, "pelvis") or next(iter(worldbody.findall("body")), None)
    if root_body is None:
        raise ValueError("template XML missing root robot body")

    link_names = set(urdf["links"])
    _remove_missing_bodies(root_body, link_names)
    for body in root.findall(".//body"):
        name = body.get("name")
        if name in link_names:
            _update_body(body, name, urdf, is_root=(body is root_body))

    _filter_actuators_and_sensors(root, set(urdf["joints"]))
    _validate(root, urdf_path.parent.parent)

    _indent(root)
    output_xml_path.parent.mkdir(parents=True, exist_ok=True)
    tree.write(output_xml_path, encoding="utf-8", xml_declaration=False, short_empty_elements=True)
    text = output_xml_path.read_text(encoding="utf-8")
    if not text.endswith("\n"):
        output_xml_path.write_text(text + "\n", encoding="utf-8")

    return {
        "model": root.get("model", ""),
        "urdf": str(urdf_path),
        "template": str(template_xml_path),
        "output": str(output_xml_path),
    }


def _validate(root: ET.Element, robot_dir: Path) -> None:
    meshdir = root.find("compiler").get("meshdir", "../meshes/") if root.find("compiler") is not None else "../meshes/"
    mesh_base = (robot_dir / "mjcf" / meshdir).resolve()
    defined_meshes = {mesh.get("name"): mesh for mesh in root.findall("./asset/mesh") if mesh.get("name")}

    missing_defs = []
    missing_files = []
    for geom in root.findall(".//geom"):
        mesh_name = geom.get("mesh")
        if not mesh_name:
            continue
        mesh = defined_meshes.get(mesh_name)
        if mesh is None:
            missing_defs.append(mesh_name)
            continue
        mesh_file = mesh.get("file")
        if mesh_file:
            full = (mesh_base / mesh_file).resolve()
            if not full.exists() or full.stat().st_size <= 0:
                missing_files.append(str(full))

    joint_names = {joint.get("name") for joint in root.findall(".//joint") if joint.get("name")}
    bad_actuators = [
        motor.get("name") or motor.get("joint")
        for motor in root.findall("./actuator/*")
        if motor.get("joint") and motor.get("joint") not in joint_names
    ]
    bad_sensors = [
        sensor.get("name") or sensor.get("joint")
        for sensor in root.findall("./sensor/*")
        if sensor.get("joint") and sensor.get("joint") not in joint_names
    ]

    errors = []
    if missing_defs:
        errors.append("missing mesh definitions: " + ", ".join(sorted(set(missing_defs))))
    if missing_files:
        errors.append("missing mesh files: " + ", ".join(sorted(set(missing_files))))
    if bad_actuators:
        errors.append("actuators reference missing joints: " + ", ".join(bad_actuators))
    if bad_sensors:
        errors.append("sensors reference missing joints: " + ", ".join(bad_sensors))
    if errors:
        raise ValueError("; ".join(errors))


def find_paths_for_urdf(assets_dir: Path, urdf_rel_path: str) -> tuple[Path, Path, Path]:
    urdf_path = (assets_dir / urdf_rel_path).resolve()
    if not str(urdf_path).startswith(str(assets_dir.resolve())):
        raise ValueError("URDF path escapes assets directory")
    if urdf_path.parent.name != "urdf":
        raise ValueError("URDF must be under a robot urdf/ directory")

    robot_dir = urdf_path.parent.parent
    mjcf_dir = robot_dir / "mjcf"
    output_xml = mjcf_dir / f"{urdf_path.stem}.xml"
    if output_xml.exists():
        template = output_xml
    else:
        preferred = mjcf_dir / f"{robot_dir.name}.xml"
        if preferred.exists():
            template = preferred
        else:
            candidates = sorted(mjcf_dir.glob("*.xml"))
            if not candidates:
                raise FileNotFoundError(f"No MJCF template XML found under {mjcf_dir}")
            template = candidates[0]
    return urdf_path, template, output_xml


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate/update Lumos MJCF XML from URDF.")
    parser.add_argument("--assets-dir", type=Path, default=Path(__file__).resolve().parents[1] / "robots")
    parser.add_argument("--urdf", required=True, help="URDF path relative to assets dir, or absolute path")
    parser.add_argument("--template", type=Path, help="MJCF template XML. Defaults to same-name XML or robot base XML.")
    parser.add_argument("--output", type=Path, help="Output MJCF XML. Defaults to sibling mjcf/<urdf-stem>.xml.")
    parser.add_argument("--model", help="MJCF model name. Defaults to URDF stem.")
    args = parser.parse_args()

    assets_dir = args.assets_dir.resolve()
    urdf_arg = Path(args.urdf)
    if urdf_arg.is_absolute():
        urdf_path = urdf_arg.resolve()
        rel = os.path.relpath(urdf_path, assets_dir)
        _, default_template, default_output = find_paths_for_urdf(assets_dir, rel)
    else:
        urdf_path, default_template, default_output = find_paths_for_urdf(assets_dir, args.urdf)

    template = args.template.resolve() if args.template else default_template
    output = args.output.resolve() if args.output else default_output
    result = generate_mjcf(urdf_path, template, output, args.model)
    print(f"generated {result['output']}")
    print(f"template  {result['template']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
