# Legacy Native Messaging host

Archived Chrome Native Messaging host entry point and implementation snapshot.

- `tokenless-native-host.rs` — former binary entry point
- `native_host.rs` — implementation snapshot taken when the host was removed from the active daemon build

The active daemon crate no longer builds or ships `tokenless-native-host`. A working copy of attachment cleanup and protocol constants remains inside `packages/daemon/src/native_host.rs` only because the HTTP control plane still shares those helpers. That module is not a user-facing Native Messaging product surface.
