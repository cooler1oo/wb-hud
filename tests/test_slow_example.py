"""慢测试示例：标了 pytest.mark.slow，PR 上不跑，只在合进 main 之后跑。

留这个文件是为了让你一眼看出 ② 和 ③ 的区别：
删掉它，②③ 的差别就看不出来了。
"""

import pytest

from app.calc import add

pytestmark = pytest.mark.slow


def test_add_slow():
    assert add(100, 200) == 300
