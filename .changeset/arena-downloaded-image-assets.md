---
'tokenless': minor
---

Add ChatGPT, Grok, Arena, and Meta AI browser-mode image asset downloads: generated PNG/JPEG/WebP bytes are verified and stored under task-, conversation-, job-, and time-scoped assets, while responses expose a relative asset reference, metadata, and SHA-256 digest. Add authenticated daemon readback at `/v1/asset/{taskId}/{conversationId}/{assetBatch}/{assetFile}`.

新增 ChatGPT、Grok、Arena 与 Meta AI browser mode 图片 asset 下载能力：生成得到的 PNG/JPEG/WebP bytes 会经过验证，并按 task、conversation、job 与时间保存；response 只暴露 relative asset reference、metadata 与 SHA-256 digest。新增 authenticated daemon 读取接口 `/v1/asset/{taskId}/{conversationId}/{assetBatch}/{assetFile}`。
