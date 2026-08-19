# 夕小瑶 · 星夜研究台

以夕小瑶角色、深色研究台和高可读性玻璃面板为核心的 DeepSeek Harness Web 皮肤。

```bash
npx --yes --package=https://github.com/147228/dsh-xiaoyao-skins/releases/latest/download/xiaoyao-skin-kit.tgz xiaoyao-skin use xiaoyao-night
```

当前包只完成骨架、元数据和最小占位挂载。皮肤通过 `body[data-dsh-xiaoyao-night]`
隔离样式，并在停用时恢复标题和注入 chrome；不修改会话、模型、工具、沙箱和权限逻辑。
