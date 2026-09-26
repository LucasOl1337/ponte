# Contributing

Start with an issue for a large change. A small fix can go directly into a pull request with a clear reproduction, the resulting behavior and relevant validation.

Run `npm test` and `./android/test.sh`. For Android packaging changes, also run `python3 android/tests/build_fixture_test.py`. Keep fixtures temporary and synthetic. Tests must not move a developer's pointer, type into their session, read their clipboard, record their microphone or capture their monitors incidentally.

For service lifecycle changes, also run `PONTE_SYSTEMD_TEST=1 node --test tests/service-lifecycle.test.mjs` on Linux with a user systemd manager. It exercises the generated units under temporary names, substitutes `sleep` for the input daemon, and removes its units afterward. It never creates an input device or starts the installed Ponte services.

Use dependency injection for desktop command tests. Use a dedicated graphical test session when a real GUI is necessary. Phone tests need temporary exclusivity over that physical phone.

For agent-driven app control, start with `./ponte ctl schema` and the
[CLI guide](docs/cli.md). Add new server actions to `bin/ctl-catalog.mjs` and
cover them through `tests/ctl.test.mjs`. Help and dry-run must stay offline,
passwords must stay out of argv, and mutating requests must never auto-retry.

The native companion is under `desktop/`. `npm run test:desktop` runs its stdlib
bridge and subprocess CLI tests with fake Android tools. With PySide6 and an
isolated graphical test session, also run `python3 -m unittest discover -s
desktop/tests -p test_gui.py`. Never use a personal phone for incidental tests.
The `./ponte desktop --demo` UI does not use ADB or scrcpy. This first native
companion UI is PT-BR only. The web/Android language policy below is unchanged.

Do not commit local configuration, certificates, pairing tokens, signing keys, recordings or customized APKs. A screenshot must exclude private notifications and unrelated applications. Label simulated demonstrations and generated artwork clearly.

English is the default interface language, with Portuguese as an optional saved preference. Update both catalogs when changing interface text. Improvements to first-time pairing are welcome. Avoid adding cloud services or analytics to complete local tasks.

By contributing, you agree to license your contribution under the project's MIT license. You retain copyright to your work.
