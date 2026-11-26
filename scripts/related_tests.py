"""② 开 PR 时：只跑和这次改动相关的测试（Python 项目通用版）。

用法：python scripts/related_tests.py [对比的分支]
      不写分支时：CI 里用 origin/<PR 的目标分支>，本地用 main。

怎么判断「相关」：
- 改了测试文件 → 跑它
- 改了源码 → 顺着 import 关系，找出直接、间接用到它的模块，再跑 import 了这些模块的测试
- 改了依赖、配置、conftest.py、__init__.py、CI 文件 → 影响面说不清，跑全部快测试
- 只改了文档之类 → 不跑
慢测试（@pytest.mark.slow，或文件里写 pytestmark = pytest.mark.slow）一律不跑，留给 ③。
不依赖任何第三方库，src/ 布局和平铺布局都能用，认得相对导入。
"""

from __future__ import annotations

import ast
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {
    ".git",
    ".venv",
    "venv",
    "env",
    "node_modules",
    "build",
    "dist",
    "__pycache__",
    ".tox",
    ".nox",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    "site-packages",
}
# 改到这些，影响面说不清，跑全部快测试
RUN_ALL_FILES = {
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "requirements.txt",
    "poetry.lock",
    "uv.lock",
    "Pipfile",
    "Pipfile.lock",
    "tox.ini",
    "pytest.ini",
    "noxfile.py",
    "conftest.py",
    "__init__.py",
    ".pre-commit-config.yaml",
}
RUN_ALL_PREFIXES = (".github/", ".gitlab-ci", "scripts/related_tests.py")
SLOW_MARK = "slow"


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout


def default_base() -> str:
    target = os.environ.get("GITHUB_BASE_REF")
    return f"origin/{target}" if target else "main"


def py_files():
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [
            d for d in dirnames if d not in SKIP_DIRS and not d.endswith(".egg-info")
        ]
        for f in filenames:
            if f.endswith(".py"):
                yield Path(dirpath, f)


def is_test(p: Path) -> bool:
    return p.name.startswith("test_") or p.name.endswith("_test.py")


def module_name(p: Path) -> str | None:
    """文件 → 模块名。从文件往上找，一直到不再有 __init__.py 的那层目录为止。"""
    parts = [] if p.name == "__init__.py" else [p.stem]
    d = p.parent
    while (d / "__init__.py").exists() and d != ROOT:
        parts.insert(0, d.name)
        d = d.parent
    return ".".join(parts) or None


def imports_of(p: Path, mod: str | None) -> set[str]:
    """这个文件 import 了哪些模块。

    含 from a import b 里可能是子模块的 a.b，也含相对导入。
    """
    try:
        tree = ast.parse(p.read_text(encoding="utf-8"))
    except (SyntaxError, UnicodeDecodeError):
        return set()
    pkg = (mod or "").split(".")
    if p.name != "__init__.py":
        pkg = pkg[:-1]
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = pkg[: len(pkg) - (node.level - 1)] if node.level > 1 else pkg
                base_name = ".".join(base + ([node.module] if node.module else []))
            else:
                base_name = node.module or ""
            if base_name:
                out.add(base_name)
            out.update(
                f"{base_name}.{a.name}" if base_name else a.name for a in node.names
            )
    return out


def only_slow(p: Path) -> bool:
    """整个测试文件都是慢测试吗。"""
    text = p.read_text(encoding="utf-8")
    if (
        f"pytestmark = pytest.mark.{SLOW_MARK}" in text
        or f"pytest.mark.{SLOW_MARK}]" in text
    ):
        return True
    n_tests = text.count("def test_")
    return n_tests > 0 and n_tests == text.count(f"@pytest.mark.{SLOW_MARK}")


def main() -> int:
    sys.stdout.reconfigure(line_buffering=True)
    base = sys.argv[1] if len(sys.argv) > 1 else default_base()
    changed = [
        f for f in git("diff", "--name-only", f"{base}...HEAD").splitlines() if f
    ]
    print(
        f"和 {base} 相比，改了 {len(changed)} 个文件：",
        *changed or ["（没有）"],
        sep="\n  ",
    )

    files = list(py_files())
    tests = [p for p in files if is_test(p)]
    sources = {p: module_name(p) for p in files if not is_test(p)}
    by_path = {p.relative_to(ROOT).as_posix(): p for p in files}

    run_all = [
        f
        for f in changed
        if Path(f).name in RUN_ALL_FILES
        or f.startswith(RUN_ALL_PREFIXES)
        or Path(f).name.startswith("requirements")
    ]
    if run_all:
        print("改到依赖、配置或公共入口，跑全部快测试：", *run_all, sep="\n  ")
        targets = [p.relative_to(ROOT).as_posix() for p in tests if not only_slow(p)]
    else:
        # 源码改动 → 受影响的模块（顺着 import 往上找，直到不再扩大）
        affected = {
            sources[by_path[f]]
            for f in changed
            if f in by_path and by_path[f] in sources and sources[by_path[f]]
        }
        graph = {m: imports_of(p, m) for p, m in sources.items() if m}
        grew = True
        while grew:
            grew = False
            for m, deps in graph.items():
                if m not in affected and deps & affected:
                    affected.add(m)
                    grew = True
        selected = set()
        for t in tests:
            rel = t.relative_to(ROOT).as_posix()
            if rel in changed or imports_of(t, module_name(t)) & affected:
                if not only_slow(t):
                    selected.add(rel)
        targets = sorted(selected)

    total = sum(1 for p in tests if not only_slow(p))
    if not targets:
        print(f"没有和这次改动相关的快测试（快测试共 {total} 个），跳过。")
        return 0
    print(
        f"要跑的测试文件：{len(targets)} 个（快测试共 {total} 个）",
        *targets,
        sep="\n  ",
    )
    code = subprocess.run(
        [sys.executable, "-m", "pytest", "-m", f"not {SLOW_MARK}", *targets], cwd=ROOT
    ).returncode
    return 0 if code == 5 else code  # 5 = 选中的测试全被过滤掉了，不算失败


if __name__ == "__main__":
    sys.exit(main())
