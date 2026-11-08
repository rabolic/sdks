import 'clock.dart';

/// Size limits from the protocol (§2).
abstract final class Limits {
  /// Longest event name, in characters.
  static const int eventName = 200;

  /// Most keys in one level of `properties` or `traits`.
  static const int keysPerLevel = 255;

  /// Longest property key, in characters.
  static const int keyLength = 255;

  /// Deepest nesting of objects and arrays, counting the top level as 1.
  static const int depth = 5;

  /// Largest serialized event, in bytes.
  static const int eventBytes = 32 * 1024;

  /// Longest `user_id`, in characters.
  static const int userId = 255;

  /// Longest `anonymous_id`, in characters.
  static const int anonymousId = 128;

  /// Longest `context.screen_name`, in characters.
  static const int screenName = 256;

  /// Longest short context string (`app.version`, `device.model`, …).
  static const int shortText = 512;

  /// Longest URL in `context` or a `$deep_link` property.
  static const int url = 2048;
}

final RegExp _controlCharacters = RegExp(r'[\u0000-\u001f\u007f]');

/// Why [name] can't be used as an event name, or `null` when it can.
///
/// `$` names are reserved for the SDK, so callers pass [allowReserved] only
/// for the SDK's own events.
String? eventNameProblem(String name, {bool allowReserved = false}) {
  if (name.isEmpty) return 'is empty';
  if (name.runes.length > Limits.eventName) {
    return 'is longer than ${Limits.eventName} characters';
  }
  if (_controlCharacters.hasMatch(name)) return 'contains control characters';
  if (!allowReserved && name.startsWith(r'$')) {
    return r'starts with "$", which is reserved for Rabolic events';
  }
  return null;
}

/// [value] cut to at most [maxCharacters] Unicode characters.
String truncate(String value, int maxCharacters) {
  final runes = value.runes;
  if (runes.length <= maxCharacters) return value;
  return String.fromCharCodes(runes.take(maxCharacters));
}

/// Returns a JSON-safe copy of [input] that fits the protocol's property
/// limits, reporting everything it leaves out to [onDrop].
///
/// Accepts strings, numbers, booleans, null, lists and maps, and converts a
/// few common Dart types: [DateTime] to an RFC 3339 string, [Enum] to its
/// name and [Uri] to a string. Anything else is dropped rather than sent as
/// an unpredictable `toString()`.
Map<String, Object?> sanitizeProperties(
  Map<String, Object?> input,
  void Function(String problem) onDrop,
) {
  return _sanitizeMap(input, 1, '', onDrop);
}

Map<String, Object?> _sanitizeMap(
  Map<Object?, Object?> input,
  int depth,
  String path,
  void Function(String) onDrop,
) {
  final output = <String, Object?>{};
  for (final entry in input.entries) {
    final key = entry.key.toString();
    final keyPath = path.isEmpty ? key : '$path.$key';
    if (key.isEmpty || key.runes.length > Limits.keyLength) {
      onDrop(
        'dropped key "${truncate(key, 40)}": keys must be 1 to '
        '${Limits.keyLength} characters',
      );
      continue;
    }
    if (output.length >= Limits.keysPerLevel) {
      onDrop('dropped "$keyPath": more than ${Limits.keysPerLevel} keys');
      continue;
    }
    final (ok, value) = _sanitizeValue(entry.value, depth, keyPath, onDrop);
    if (ok) output[key] = value;
  }
  return output;
}

(bool, Object?) _sanitizeValue(
  Object? value,
  int depth,
  String path,
  void Function(String) onDrop,
) {
  switch (value) {
    case null || bool() || String() || int():
      return (true, value);
    case double():
      if (value.isFinite) return (true, value);
      onDrop('dropped "$path": $value is not a finite number');
      return (false, null);
    case DateTime():
      return (true, formatTimestamp(value));
    case Enum():
      return (true, value.name);
    case Uri():
      return (true, value.toString());
    case Map<Object?, Object?>() || Iterable<Object?>()
        when depth >= Limits.depth:
      onDrop('dropped "$path": nested deeper than ${Limits.depth} levels');
      return (false, null);
    case Map<Object?, Object?>():
      return (true, _sanitizeMap(value, depth + 1, path, onDrop));
    case Iterable<Object?>():
      final list = <Object?>[];
      var index = 0;
      for (final item in value) {
        final (ok, clean) = _sanitizeValue(
          item,
          depth + 1,
          '$path[$index]',
          onDrop,
        );
        if (ok) list.add(clean);
        index++;
      }
      return (true, list);
    default:
      onDrop('dropped "$path": ${value.runtimeType} is not a JSON value');
      return (false, null);
  }
}
