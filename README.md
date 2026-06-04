# URDF Collision Editor

一个基于 Flask + Three.js 的可视化 URDF 碰撞体编辑器，用于快速查看、调整和保存 URDF 中的 `<collision>` 几何体。

## 功能

- 加载本地 `robots/` 下的 `.urdf` 文件
- 显示机器人 STL 视觉网格和 collision 几何体
- 支持选中 collision 后进行：
  - 平移
  - 旋转
  - 键盘缩放 / 修改尺寸
- 支持右侧参数面板直接编辑：
  - origin xyz
  - origin rpy
  - box / cylinder / sphere 参数
- 支持新增、复制、删除碰撞体
- 支持在 3D 视图中右键创建 box / cylinder / sphere 碰撞体
- 支持单个碰撞体镜像到对侧 link，也支持整个 link 的碰撞体批量镜像
- 支持按选中碰撞体切换 X / Y / Z 观察视角
- 支持碰撞体颜色、视觉网格透明度、显示开关和磁力吸附开关的本地记忆
- 支持磁力吸附，将平移后的碰撞体吸附到当前 link 的视觉网格边界附近
- 保存时尽量保留原 URDF 的格式排布，只替换变更过的 collision 块
- 支持 `Cmd+Z` / `Ctrl+Z` 撤销

## 键盘操作

### Gizmo 模式

| 快捷键 | 功能 |
| --- | --- |
| `T` | 平移模式 |
| `R` | 旋转模式 |
| `S` | 缩放模式，选轴后用 `↑` / `↓` 调整尺寸 |
| `Esc` | 取消选择 |
| `Delete` / `Backspace` | 删除当前选中碰撞体 |
| `Cmd+Z` / `Ctrl+Z` | 撤销 |

### 轴向键盘微调

平移模式下方向键使用固定语义：

| 按键 | 功能 |
| --- | --- |
| `↑` / `↓` | 前后移动，修改 X |
| `←` / `→` | 左右移动，修改 Y |
| `Shift + 方向键` | 更细粒度移动 |

缩放模式下，先在顶部选择编辑轴 `X / Y / Z`，也可以用快捷键：

| 快捷键 | 功能 |
| --- | --- |
| `X` | 选择 X 轴 |
| `Y` | 选择 Y 轴 |
| `Z` | 选择 Z 轴 |

选中碰撞体后：

| 按键 | 功能 |
| --- | --- |
| `S` 后 `↑` | 沿当前轴放大尺寸 |
| `S` 后 `↓` | 沿当前轴缩小尺寸 |
| `Shift + ↑/↓` | 更细粒度缩放 |

默认键盘移动和缩放步长为 `0.0001m`，按住 `Shift` 时为 `0.00001m`。

为避免误触，平移和缩放模式不会显示可拖动坐标轴手柄；旋转模式仍显示旋转控件。

## 可视化控制

- `视觉网格`、`碰撞体`、`关节轴` 可分别开关显示
- 视觉网格透明度可通过顶部滑条调整
- 碰撞体颜色可通过顶部颜色选择器调整，默认黄色
- 选中的碰撞体使用独立青色高亮，便于与自定义碰撞体颜色区分
- `视角 X / Y / Z` 会围绕当前选中的碰撞体切换观察方向；未选中时围绕整机
- 进入 X / Y / Z 视角后，一旦鼠标移动视角，会自动回到普通全局轨道视角
- 这些可视化配置会保存到浏览器 `localStorage`，下次打开自动恢复

## 镜像与吸附

- `镜像单个`：将当前碰撞体镜像到 `left_` / `right_` 对侧 link 的同序号碰撞体
- `镜像 Link`：将当前 link 下全部未删除碰撞体批量镜像到对侧 link
- 镜像规则为局部 `origin.xyz.y` 取反，几何尺寸复制，RPY 保持一致
- `磁力吸附` 开启后，平移结束或键盘平移后，会优先吸附到当前 link 的视觉网格包围盒边界附近

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
