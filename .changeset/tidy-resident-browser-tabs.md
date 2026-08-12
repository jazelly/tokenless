---
"tokenless": patch
---

Prevent resident managed browsers from accumulating diagnostic `chrome://version` tabs and released provider `about:blank` pages across repeated test or worker detach cycles. Real provider, protected, borrowed, and control-plane pages remain open.

防止驻留的托管浏览器在重复测试或 worker detach 后不断累积诊断用 `chrome://version` tab 与已释放的 provider `about:blank` 页面。真实 provider、protected、borrowed 与 control-plane 页面仍保持打开。
