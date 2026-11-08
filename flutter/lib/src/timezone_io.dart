import 'dart:io';

/// The IANA time zone name (`Europe/Berlin`), or `null` when the platform
/// only offers an abbreviation.
///
/// Dart on iOS and Android reports abbreviations such as `CET`, which are
/// ambiguous (`CST` is both US Central and China), so they aren't sent. The
/// `TZ` variable is honored when set, which it is in some test and server
/// environments.
String? ianaTimeZone() {
  final candidates = <String?>[
    Platform.environment['TZ'],
    DateTime.now().timeZoneName,
  ];
  for (final name in candidates) {
    if (name != null && name.contains('/')) return name;
  }
  return null;
}
