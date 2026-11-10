# Contributing

Thanks for helping. Run these before opening a pull request:

```
claude plugin test .
npx -y -p typescript tsc -p .
claude plugin validate .
bash tests/xcq-test.sh
bash tests/xcsim-test.sh
bash tests/xcwatch-test.sh
bash tests/shim-test.sh
bash tests/gradle-test.sh
```

Point `SIMAPHORE_DIR` at a temporary folder so tests never touch your real state.

## Layout

- `hooks/`: the plugin. The drawing is pure (`screen.tsx`, `settings.tsx`); only
  `register.tsx` reads or changes anything. Android parsing lives in `android.ts`. Expected renders live in
  `screen.snapshots.ts`.
- `bin/`: the shell helpers (`xcq`, `xcsim`, `xcwatch`, `xcpause`, `xcgradle`, and the
  `xcodebuild`, `xcrun`, `simctl`, `adb`, `emulator` and `android` stand-ins in `bin/shim/`).
- `tests/`: shell tests for the helpers.
- `scripts/shots.sh`: redraws the screenshots in `docs/images/` from the demo scenes.

## Screenshots

```
bash scripts/shots.sh
```

This compiles `scripts/shots.ts` and writes SVG files. Set `TSC` to a `tsc` binary
if `npx` is not available.

## Trying a change live

Load your copy with `claude --plugin-dir <path>` and use a throwaway `SIMAPHORE_DIR`.
Use only simulators you do not mind being shut down.
