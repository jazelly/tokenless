---
"tokenless": minor
---

Replace managed browser profile imports with headed native connections to the user's running Google Chrome 144+ instance. After the user enables Remote Debugging, Chrome manages the CDP endpoint and Tokenless discovers it without a fixed-port setting. Tokenless checks support by connecting, manages only its own tabs, and disconnects without closing Chrome when the daemon stops.
