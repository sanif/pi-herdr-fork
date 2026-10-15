# pi-herdr-fork

Fork a [Pi](https://github.com/earendil-works/pi) session into a new [Herdr](https://herdr.dev) pane or tab, from the current state or from any earlier message. The original session keeps running.

```text
/herdr-fork          pick a fork point, then where to open it
/herdr-fork right    new pane to the right
/herdr-fork down     new pane below
/herdr-fork tab      new tab
```

`Ctrl+Alt+F` opens the same picker, including while the agent is responding.

## Fork points

- **Current state**: copies the whole conversation, like Pi's `/clone`, and opens with an empty editor. If the agent is mid-response, the fork ends at the last point where every tool call has its result.
- **An earlier message**: copies the conversation up to just before that message and puts the message back in the editor, like Pi's `/fork`. Edit it and send to try a different direction.

The new session is saved like any other Pi session and links back to the original. The original session is not modified.

## Requirements

- Herdr 0.7.4 or later, with Pi running inside a Herdr pane
- A saved session (not `--no-session`)
- This package installed for the Pi that starts in the new pane, so it can restore the message into the editor

## Install

```bash
pi install npm:@sanif/pi-herdr-fork
```

or

```bash
pi install git:github.com/sanif/pi-herdr-fork
```

## Shortcut

To change `Ctrl+Alt+F`, create `~/.pi/agent/extensions/pi-herdr-fork.json`:

```json
{ "shortcut": "ctrl+shift+k" }
```

Use Pi's key syntax (`ctrl`, `alt`, `shift`, `super`, then one key). Set `"shortcut": false` to turn it off, then run `/reload`. An invalid value falls back to `Ctrl+Alt+F` with a warning.

On macOS, `Alt` keys only reach Pi when the terminal sends Option as Alt, for example Ghostty's `macos-option-as-alt` or iTerm2's "Option key sends Esc+".

## Troubleshooting

- **"run Pi inside a Herdr pane"**: start Pi from a Herdr pane, not a plain terminal.
- **The message is not in the new pane's editor**: install the package with `pi install`, not only `--extension`.
- **Pi does not start in the new pane**: the error shows Herdr's reason and the empty pane is closed. The extension waits up to 15 seconds for the new shell to reach its prompt; a shell that asks a question at startup still needs an answer. Check that `herdr agent start --kind pi` works from a shell.

## Privacy

No network requests. The chosen message reaches the new pane through a private temporary file (mode `0600`) that is deleted once read; leftovers are removed after 24 hours.

## Development

```bash
bun install
bun run verify
```

`verify` runs the type check, tests, and a package dry run.

## Credits

The Herdr launch approach follows [pi-herdr-btw](https://www.npmjs.com/package/pi-herdr-btw) (MIT).

## License

MIT
