import 'package:shared_preferences/shared_preferences.dart';

/// Small string storage for ids, flags and cached config.
///
/// Wraps `shared_preferences` so the core logic can be tested with
/// [MemoryKeyValueStore].
abstract interface class KeyValueStore {
  /// The value for [key], or `null`.
  Future<String?> getString(String key);

  /// Stores [value] under [key].
  Future<void> setString(String key, String value);

  /// Removes [key].
  Future<void> remove(String key);
}

/// [KeyValueStore] backed by `shared_preferences`: `UserDefaults` on iOS,
/// `SharedPreferences` / DataStore on Android, `localStorage` on the web.
class SharedPreferencesStore implements KeyValueStore {
  /// Creates the store.
  SharedPreferencesStore([SharedPreferencesAsync? preferences])
    : _preferences = preferences ?? SharedPreferencesAsync();

  final SharedPreferencesAsync _preferences;

  @override
  Future<String?> getString(String key) => _preferences.getString(key);

  @override
  Future<void> setString(String key, String value) =>
      _preferences.setString(key, value);

  @override
  Future<void> remove(String key) => _preferences.remove(key);
}

/// In-memory [KeyValueStore], for tests and as a fallback when storage is
/// unavailable.
class MemoryKeyValueStore implements KeyValueStore {
  /// Creates the store, optionally pre-filled with [values].
  MemoryKeyValueStore([Map<String, String>? values])
    : values = values ?? <String, String>{};

  /// The stored values. Tests read and seed it directly.
  final Map<String, String> values;

  @override
  Future<String?> getString(String key) async => values[key];

  @override
  Future<void> setString(String key, String value) async => values[key] = value;

  @override
  Future<void> remove(String key) async => values.remove(key);
}

/// Uses [primary] until it throws once, then [fallback] for the rest of the
/// process. On the web `localStorage` can be blocked (private modes, strict
/// cookie settings); tracking should carry on in memory rather than fail.
class FallbackKeyValueStore implements KeyValueStore {
  /// Creates the store.
  FallbackKeyValueStore(this.primary, [KeyValueStore? fallback])
    : fallback = fallback ?? MemoryKeyValueStore();

  /// The preferred store.
  final KeyValueStore primary;

  /// The store used after [primary] fails.
  final KeyValueStore fallback;

  bool _usingFallback = false;

  Future<T> _run<T>(Future<T> Function(KeyValueStore store) operation) async {
    if (!_usingFallback) {
      try {
        return await operation(primary);
      } on Object {
        _usingFallback = true;
      }
    }
    return operation(fallback);
  }

  @override
  Future<String?> getString(String key) => _run((s) => s.getString(key));

  @override
  Future<void> setString(String key, String value) =>
      _run((s) => s.setString(key, value));

  @override
  Future<void> remove(String key) => _run((s) => s.remove(key));
}
