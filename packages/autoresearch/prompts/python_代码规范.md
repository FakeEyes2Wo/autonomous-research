# Athena 代码规范

Status: current
Last verified: 2026-07-30
Source of truth: `pyproject.toml` and current Python source

## 导入

### 所有导入必须放在文件开头

禁止在函数或方法体内使用 `import` / `from ... import`，除非存在无法解决的循环依赖（此时必须加注释 `# 延迟导入避免循环依赖`）。

```python
# ✓ 正确
import asyncio
from pathlib import Path
from athena.core.tool import ToolRegistry

# ✗ 错误
def foo():
    from pathlib import Path  # 不要这样做
    ...
```

### 不使用 `from __future__ import annotations`

项目最低支持 Python 3.11，不需要 PEP 563 的惰性求值。遇到前向引用时，使用字符串注解：

```python
# ✓ 正确 — 前向引用用字符串
class TurnRuntime:
    done: "asyncio.Future[TurnTerminalState]" = ...

class TurnTerminalState:  # 定义在 TurnRuntime 之后
    ...

# ✗ 错误
from __future__ import annotations  # 不要加这个
```

### TYPE_CHECKING 仅用于避免循环导入

```python
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from athena.memory.context_manager import ContextManager
```

### 导入顺序

1. 标准库
2. 第三方库
3. 项目内模块

每组之间空一行。

---

## 注释

### 函数与方法

每个公开函数/方法必须有 docstring，描述**做什么**（不是怎么做）。简单的内部函数可以省略。

```python
# ✓ 正确
def _to_str(r: Any) -> str:
    """将 ToolResult 或异常转为字符串，用于写入对话历史。"""
    ...

# ✗ 错误 — 重复函数名、无信息量
def add_numbers(a: float, b: float) -> float:
    """Return the sum of two numbers."""  # 函数名已经说明了
    return a + b
```

### 类

公开类必须有 docstring，说明职责和关键设计决策。

```python
class Agent(BaseAgent):
    """流式工具调用 Agent Loop。

    每个 Turn：system prompt 注入 → 用户输入注入 → 多轮采样直到 LLM 输出纯文本。
    concurrency_safe 工具并行执行，非安全工具按顺序串行化。
    """
```

同时类注释和成员之前不要有多余的空格，但是注释本身可以多行

```python
class RunnerFailed:
    """runner 异常退出。"""

    turn_id: str
    exception_type: str

```
应该修正喂

```python
class RunnerFailed:
    """runner 异常退出。"""
    turn_id: str
    exception_type: str

```
### 大段逻辑块

超过 15 行的函数/方法，在关键逻辑块前加单行或多行注释：

```python
async def _sampling_loop(...):
    # 阶段 1：流式接收 LLM 输出
    async for ev in provider.stream(...):
        ...

    # 阶段 2：等待所有工具执行完成
    gathered = await asyncio.gather(...)

    # 阶段 3：写入 assistant 消息到对话历史
    mem.append(ModelResponse(...))
```

### 禁止 ASCII 装饰分隔线

不使用 `# ═══`、`# ───` 等装饰性分隔线。模块级的逻辑分区用单空行即可。

```python
# ✓ 正确 — 空行分隔
class AgentOutcome:
    ...


class StepOutcome:
    ...


# ✗ 错误
# ═══════════════════════════════════
# 不要用这种装饰线
# ═══════════════════════════════════
```

---

## 异常处理

### 特定异常必须标注触发条件

`except` 捕获的如果不是 `Exception`，必须在后面用注释说明**什么场景会触发**：

```python
# ✓ 正确
except asyncio.CancelledError:
    # 外部取消信号（ThreadRuntime 关闭 / Turn 中断）→ 清理工具任务后传播
    ...
except asyncio.QueueFull:
    # 提交队列满 → 回退到阻塞 put，保证关闭信号不丢失
    ...
except json.JSONDecodeError:
    # LLM 返回了非 JSON 格式的工具参数，视为空参数
    ...

# ✗ 错误 — 没有说明触发条件
except asyncio.CancelledError:
    ...
```

### 异常处理不应滥用

- 代码逻辑中能确定类型/值的情况，不要用 `try/except` 包裹
- 异常处理应在功能完成后审查添加，初次编写时过度捕获会掩盖真实错误
- 不要用裸 `except:`（不指定异常类型）

### 常见异常及其注释模板

| 异常类型 | 注释模板 |
|---------|---------|
| `asyncio.CancelledError` | `# <操作>被取消 → <后续行为>` |
| `asyncio.TimeoutError` | `# <操作>超时 → <后续行为>` |
| `asyncio.QueueFull` | `# 队列满 → 回退到阻塞 put / 丢弃` |
| `asyncio.QueueEmpty` | `# 队列已空 → 无更多数据` |
| `KeyError` | `# <键>不存在于<数据结构>中` |
| `RuntimeError` | `# <状态冲突描述>` |
| `json.JSONDecodeError` | `# JSON 解析失败（<数据来源>）→ 回退为<默认值>` |

---

## 空行与格式

### 模块级

- 导入与代码之间：一个空行
- 类/函数定义之间：一个空行
- 逻辑分组之间：一个空行
- **禁止**连续两个空行

```python
# ✓ 正确
import asyncio
from dataclasses import dataclass

from athena.core.tool import ToolRegistry


@dataclass
class AgentOutcome:
    result_ref: str
    next_context_ref: str


class Agent:
    ...
```

### 代码块内

一个完整逻辑块内部不插入空行；不同逻辑块之间用一个空行分隔。

---

## 代码结构

### 嵌套深度

代码嵌套不超过 3 层。超过时抽取为独立函数。

```python
# ✗ 不推荐 — 4 层嵌套
if user:
    if user.is_active():
        if user.has_permission():
            if user.can_execute():
                ...

# ✓ 推荐 — 提前 return 减少嵌套
if not user:
    return
if not user.is_active():
    return
if not user.has_permission():
    return
user.execute()
```

### 简单优于复杂


- 不引入无必要的设计模式、多层封装、复杂继承
- **一个函数的输入参数应该尽可能地少，减少维护代码时的心智负担**
- **一个类的attrs应尽可能少，减少维护的心智负担。**
- 能用标准库解决的问题不引入新依赖
- 框架已有的功能不要重写
- 减少 `_` 开头的、功能简单且调用次数少于 2 次的私有函数（降低可读性）

---

## 测试

每个模块需要有单元测试。公开函数需要有一个简单的输入输出示例放在 docstring 或测试文件中。
同时当前文件的主要功能模块需要到文件的  if __name__=="__main__": 下面简单写出一个使用示例

---

## 文件结构

```text
# 1. 导入（标准库 → 第三方 → 项目内）
import asyncio
from pathlib import Path

from pydantic_ai.messages import ModelMessage

from athena.core.tool import ToolRegistry

# 2. 常量
MAX_RETRIES = 3

# 3. 类与函数
class Foo:
    ...


def bar():
    ...
```
