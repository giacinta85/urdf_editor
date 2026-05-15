# URDF Collision Editor

一个基于 Flask + Three.js 的可视化 URDF 碰撞体编辑器，用于快速查看、调整和保存 URDF 中的 `<collision>` 几何体。

## 功能

- 加载本地 `robots/` 下的 `.urdf` 文件
- 显示机器人 STL 视觉网格和 collision 几何体
- 支持选中 collision 后进行：
  - 平移
  - 旋转
  - 缩放 / 修改尺寸
- 支持右侧参数面板直接编辑：
  - origin xyz
  - origin rpy
  - box / cylinder / sphere 参数
- 支持新增、复制、删除碰撞体
- 保存时尽量保留原 URDF 的格式排布，只替换变更过的 collision 块
- 支持 `Cmd+Z` / `Ctrl+Z` 撤销

## 键盘操作

### Gizmo 模式

| 快捷键 | 功能 |
| --- | --- |
| `T` | 平移模式 |
| `R` | 旋转模式 |
| `S` | 缩放模式 |
| `Esc` | 取消选择 |
| `Delete` / `Backspace` | 删除当前选中碰撞体 |
| `Cmd+Z` / `Ctrl+Z` | 撤销 |

### 轴向键盘微调

先在顶部选择编辑轴 `X / Y / Z`，也可以用快捷键：

| 快捷键 | 功能 |
| --- | --- |
| `X` | 选择 X 轴 |
| `Y` | 选择 Y 轴 |
| `Z` | 选择 Z 轴 |

选中碰撞体后：

| 按键 | 功能 |
| --- | --- |
| `↑` 或 `→` | 沿当前轴正方向移动 |
| `↓` 或 `←` | 沿当前轴负方向移动 |
| `Shift + 方向键` | 细调移动 |
| `Cmd/Ctrl + ↑` | 沿当前轴放大尺寸 |
| `Cmd/Ctrl + ↓` | 沿当前轴缩小尺寸 |
| `Shift + Cmd/Ctrl + ↑/↓` | 细调缩放 |

默认移动步长为 `5mm`，细调步长为 `1mm`。

## 安装

推荐使用 conda：

```bash
conda env create -f environment.yml
conda activate urdf_editor
```

或者直接安装 Flask：

```bash
pip install flask
```

## 启动

```bash
python app.py
```

默认地址：

```text
http://localhost:5173
```

也可以使用：

```bash
./run.sh
```

## 资产目录

默认读取：

```text
robots/
```

其中 `robots/` 目录会上传到 GitHub；但 `robots/lumos_assets/` 通常包含大量 URDF / STL / mesh 文件，已在 `.gitignore` 中忽略，不会上传到主仓库。

目录示例：

```text
robots/
  lumos_assets/        # ignored
    robot_name/
      urdf/
        robot.urdf
      meshes/
        xxx.stl
```

## 保存策略

编辑器保存时不会整体重新格式化 XML，而是：

- 对已有 collision：用原始 XML 块做字符串替换
- 对删除 collision：移除对应原始 collision 块
- 对新增 collision：插入到对应 link 的 `</link>` 前

这样可以最大程度保留原始 URDF 的缩进、注释和排布。

## 技术栈

- Python / Flask
- Three.js
- OrbitControls
- TransformControls
- STLLoader

## 注意事项

- 浏览器需要能访问 Three.js CDN
- `robots/lumos_assets/` 不会被提交到主仓库，请在本地自行放置或单独同步机器人资产
- 当前主要支持 box / cylinder / sphere 三类简化 collision 几何体
