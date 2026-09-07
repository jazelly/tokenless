---
"tokenless": patch
---

Repair Windows source-linked Tokenless API setup by invoking npm without a command shim, resolving pyenv-win's real uv executable, hiding persistent background process windows, draining CLI failures cleanly, and diagnosing native profiles through their configured browser.

修复 Windows 源码链接安装：不再通过命令 shim 调用 npm，解析 pyenv-win 的真实 uv 可执行文件，隐藏持久后台 daemon 和 service 子进程窗口，让 CLI 失败路径正常排空句柄，并通过已配置的浏览器诊断 native profile。
