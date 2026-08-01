# tools-v2 改进计划

> **时间**：2026-08-01 | **状态**：进行中

## 对照原始工具发现的差距

| 工具 | 缺失功能 | 优先级 | 复杂度 |
|------|---------|--------|--------|
| **BashTool** | stderr/stdout 分离 + 退出码语义 | ⭐⭐⭐ | 低 |
| **BashTool** | 危险命令警告 (rm -rf /) | ⭐⭐⭐ | 低 |
| **FileEditTool** | 重复匹配检测 (replace_all=false时) | ⭐⭐⭐ | 低 |
| **FileReadTool** | 最大文件大小限制 | ⭐⭐ | 低 |
| **FileReadTool** | 图片/PDF 不支持时给出明确提示 | ⭐⭐ | 低 |
| **GlobTool** | 自动排除 node_modules/.git | ⭐⭐ | 低 |
| **GrepTool** | 结果截断 + 明确计数 | ⭐⭐ | 低 |
| **FileEditTool** | git diff 生成 | ⭐ | 中 |
| **BashTool** | 后台执行 + 流式输出 | ⭐ | 高 |
| **FileReadTool** | 图片/PDF 实际解析 | ⭐ | 高 |

## 执行顺序

1. BashTool: stderr/stdout分离 + 危险命令警告
2. FileEditTool: 重复匹配检测
3. FileReadTool: 大小限制 + 图片/PDF提示
4. GlobTool: node_modules/.git排除
5. GrepTool: 结果截断计数
6. FileEditTool: git diff
