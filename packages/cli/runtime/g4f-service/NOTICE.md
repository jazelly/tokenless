# Tokenless GPT4Free service boundary

This directory contains Tokenless-owned launcher and isolation code. It installs
`g4f[all]==8.1.2` from PyPI into a private local runtime during setup; GPT4Free
is licensed separately under GPL-3.0 by its upstream authors.

Tokenless does not include GPT4Free source code or its Python environment in the
npm package. Distribution and license review remains required before changing
that installation boundary.

