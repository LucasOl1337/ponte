# Contributing

Start with an issue for a large change. A small fix can go directly into a pull request with a clear reproduction, the resulting behavior and relevant validation.

Run `npm test` and `./android/test.sh`. For Android packaging changes, also run `python3 android/tests/build_fixture_test.py`. Keep fixtures temporary and synthetic. Tests must not move a developer's pointer, type into their session, read their clipboard, record their microphone or capture their monitors incidentally.

Use dependency injection for desktop command tests. Use a dedicated graphical test session when a real GUI is necessary. Phone tests need temporary exclusivity over that physical phone.

Do not commit local configuration, certificates, pairing tokens, signing keys, recordings or customized APKs. A screenshot must exclude private notifications and unrelated applications. Label simulated demonstrations and generated artwork clearly.

English is the default interface language, with Portuguese as an optional saved preference. Update both catalogs when changing interface text. Improvements to first-time pairing are welcome. Avoid adding cloud services or analytics to complete local tasks.

By contributing, you agree to license your contribution under the project's MIT license. You retain copyright to your work.
