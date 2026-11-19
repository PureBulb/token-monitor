---
name: token-stats
description: 分析当前或历史会话的 Token 消耗、生成速度、缓存命中率以及上下文长度详情，生成结构化的性能与消耗分析报告。
---

# Token & 性能分析技能 (Token Stats)

此技能用于在用户询问或需要深入了解 Token 消耗、缓存利用率、生成速度和上下文占用情况时，快速提取真实数据并生成专业可视化分析报告。

## 数据提取流程

1. **确定会话路径**：
   - 当前会话的转储日志位于：`~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/transcript.jsonl`。
2. **分析指标**：
   - **输入 Token (Uncached Prompt Tokens)**: `step.input_tokens`
   - **缓存 Token (Cached Prompt Tokens)**: `step.cache_read_tokens`
   - **输出 Token (Completion Tokens)**: `step.output_tokens`
   - **当前上下文长度**: 最新一步的 `input_tokens + cache_read_tokens`
   - **缓存命中率**: `cache_read_tokens / (input_tokens + cache_read_tokens) * 100%`
   - **生成速度 (TPS)**: `output_tokens / duration_seconds`

## 报告格式建议

输出格式清晰的 Markdown 表格与核心概览：

```markdown
### 📊 会话 Token 与性能综合分析

| 指标维度 | 当前轮次 | 会话累计 | 评估与建议 |
| :--- | :--- | :--- | :--- |
| **消耗 Token** | `95.4k` | `2.40M` | 缓存复用度极佳，有效节省成本 |
| **生成速度** | `~56.4 t/s` | 平均 `~62.1 t/s` | 响应流畅 |
| **缓存命中率** | `97.7%` | 总体 `96.8%` | 远高于基准线 (80%)，充分命中上下文前缀 |
| **上下文长度** | `95,404` (9.1%) | 窗口上限 1,000,000 | 距离上限充裕，暂无需触发压缩 |

> 💡 **提示**：可点击侧边栏监控面板实时查看折线走势：[打开 Token 监控面板](sidecar://token-monitor/panel/)
```
