---
"tokenless": patch
---

Make ordinary daemon reuse depend on signed protocol negotiation instead of package-version majors, and let `tokenless setup` reconcile protocol mismatches or exact native-runtime drift only through verified same-home lifecycle shutdown.
