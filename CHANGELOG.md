# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — Unreleased

### Added

- **Public repository skeleton:** package manifest, MIT license, backslop tracker layout, and a GitHub Actions matrix for Node 20.
- **The bus itself:** TypeScript core with tasks, mailboxes, artifacts and the driver contract; a JavaScript runtime; drivers for Claude Code, Cursor and Codex; and the `promptobus` command.
- **A host contract instead of an ambient workspace:** `PromptobusHost` is passed explicitly on every call, with a standalone implementation that reads `cwd`, Git and `promptobus.json`. A consumer with no previous store declares no legacy layout, and that is a normal state rather than a failure.
- **Documentation for a first-time reader:** README in English and Russian, an architecture decision on the standalone boundary, and guides for installation, hooks and trust, and contributing.
