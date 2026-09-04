# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-09-05

### Changed

- **Host contract: `cloneOf(abs)` replaces `reposRoot()`.** The host names the clone a directory belongs to and its namespace path; the package no longer walks a single "repos root" or requires a two-segment namespace — `need-pair` and `cwd-need-pair` are gone from `reviewLayoutError`. A host with several zones (`repos/<group>/<repo>` beside `external/<repo>`) could not be expressed before (PB-5).

## [0.1.0] — 2026-09-04

### Added

- **Public repository skeleton:** package manifest, MIT license, backslop tracker layout, and a GitHub Actions matrix for Node 20.
- **The bus itself:** TypeScript core with tasks, mailboxes, artifacts and the driver contract; a JavaScript runtime; drivers for Claude Code, Cursor and Codex; and the `promptobus` command.
- **A host contract instead of an ambient workspace:** `PromptobusHost` is passed explicitly on every call, with a standalone implementation that reads `cwd`, Git and `promptobus.json`. A consumer with no previous store declares no legacy layout, and that is a normal state rather than a failure.
- **Documentation for a first-time reader:** README in English and Russian, an architecture decision on the standalone boundary, and guides for installation, hooks and trust, and contributing.
