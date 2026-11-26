# 项目名

一个用 ai-era-ci 技能配好的 Python 项目骨架。检查拆成三个时候：

| | 什么时候跑 | 查什么 | 放在哪 |
|---|---|---|---|
| ① | 每次 `git commit` 之前 | 格式、lint（几秒） | `.pre-commit-config.yaml` |
| ② | 开 PR 时 | 只跑和这次改动相关的测试，限时 5 分钟 | `.github/workflows/pr-fast.yml` |
| ③ | 合进 `main` 之后 | 全部测试，含慢测试 | `.github/workflows/main-full.yml` |

## 开始用

1. 点右上角 **Use this template** → 建你自己的仓库
2. 本地克隆后装一次钩子：

   ```bash
   pip install -e ".[dev]"
   pre-commit install
   ```

3. 把 `app/` 换成你的代码，`tests/` 换成你的测试
4. 改了依赖，记得同步改 `pyproject.toml` 里的 `[project.optional-dependencies]`

## 三个地方可能要改

| 要改什么 | 改哪 |
|---|---|
| 安装命令不是 `pip install -e ".[dev]"` | `pr-fast.yml` / `main-full.yml` 里那行 `run:` |
| Python 版本不是 3.12 | 两个 workflow 里的 `python-version` |
| 默认分支不叫 `main` | `main-full.yml` 的 `branches:` |

## 慢测试怎么标

```python
import pytest

pytestmark = pytest.mark.slow  # 整个文件都是慢测试
```

或者单个函数上加 `@pytest.mark.slow`。

## 两个人踩过的坑（已修，别改回去）

- `scripts/related_tests.py` 里用 `.as_posix()` 而不是 `str(path)`：Windows 上路径是反斜杠，跟 `git diff` 给的正斜杠对不上，会导致**一个测试都不选却显示绿灯**。
- `batch.py`（本模板未包含）里的 `HEAVY` 命令用双引号：`shell=True` 在 Windows 走 cmd.exe，不认单引号。

## 这个模板没包含什么

- ④ 特性开关、攒批：需要真实用户量或大量 PR 才有意义，按需再加
- JS/TS 版：`pr-fast.yml` 里有注释说明怎么换成 Vitest
