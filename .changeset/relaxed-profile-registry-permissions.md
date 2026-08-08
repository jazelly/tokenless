---
"tokenless": patch
---

Stop rejecting managed profile registries based on POSIX mode bits so valid Windows profiles remain usable while Tokenless continues to create registry files with private permissions where supported.

不再根据 POSIX mode 位拒绝托管浏览器配置注册表，避免有效的 Windows 配置被误判；Tokenless 仍会在平台支持时以私有权限创建注册表文件。
