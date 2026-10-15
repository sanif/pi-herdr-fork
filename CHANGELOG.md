# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-15

### Added

- `/herdr-fork` command that forks the current session from a chosen user message into a new Herdr pane (right or below) or a new tab.
- The chosen message is restored into the new pane's editor, matching Pi's `/fork`.
- Pi starts through `herdr agent start --kind pi`, so Herdr tracks the new pane as a Pi agent; if launch fails, the empty pane is closed and Herdr's reason is shown.
- **Current state** option at the top of the picker, forking the whole conversation so far into the new pane with an empty editor.
- `Ctrl+Alt+F` shortcut that opens the same picker, configurable or disabled through `~/.pi/agent/extensions/pi-herdr-fork.json`.
- Waits for the new pane's shell to finish its startup work (for example Oh My Zsh's update check) before starting Pi, fixing "agent target pane ... is not an available shell".
- Draft hand-off files live in a private per-user folder; leftovers older than 24 hours are pruned.
