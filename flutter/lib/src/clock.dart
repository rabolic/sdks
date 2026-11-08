/// Returns the current time. Injected so tests can control time.
typedef Clock = DateTime Function();

/// The system clock.
DateTime systemClock() => DateTime.now();

/// Formats [time] as an RFC 3339 UTC timestamp with exactly three
/// fractional digits, as the protocol requires: `2026-11-08T10:00:03.120Z`.
String formatTimestamp(DateTime time) {
  final utc = time.toUtc();
  String two(int n) => n.toString().padLeft(2, '0');
  final year = utc.year.toString().padLeft(4, '0');
  final millis = utc.millisecond.toString().padLeft(3, '0');
  return '$year-${two(utc.month)}-${two(utc.day)}'
      'T${two(utc.hour)}:${two(utc.minute)}:${two(utc.second)}.${millis}Z';
}
