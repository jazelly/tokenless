---
"tokenless": patch
---

Make ordinary daemon reuse depend on verified ready identity plus supported protocol overlap instead of package-version majors, and let `tokenless setup` reconcile protocol mismatches or installed-runtime drift only after same-home verification.
