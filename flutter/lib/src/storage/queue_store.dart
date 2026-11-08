import 'key_value_store.dart';

/// Durable storage for the event queue.
///
/// Events are stored as one JSON document per line (JSON Lines), oldest
/// first. A damaged line costs one event, not the whole queue.
abstract interface class QueueStore {
  /// The stored lines, oldest first. Returns an empty list when nothing is
  /// stored or the storage can't be read.
  Future<List<String>> load();

  /// Replaces the stored queue with [lines]. Callers never run two saves at
  /// once.
  Future<void> save(List<String> lines);
}

/// [QueueStore] that keeps nothing across restarts.
class MemoryQueueStore implements QueueStore {
  /// The last saved lines. Tests read it directly.
  List<String> lines = const <String>[];

  @override
  Future<List<String>> load() async => List<String>.of(lines);

  @override
  Future<void> save(List<String> lines) async =>
      this.lines = List<String>.unmodifiable(lines);
}

/// [QueueStore] in a [KeyValueStore] entry. Used on the web, where it ends
/// up in `localStorage` under `rb_queue`.
class KeyValueQueueStore implements QueueStore {
  /// Creates the store.
  KeyValueQueueStore(this._store, {this.key = 'rb_queue'});

  final KeyValueStore _store;

  /// The storage key.
  final String key;

  @override
  Future<List<String>> load() async {
    final value = await _store.getString(key);
    if (value == null || value.isEmpty) return <String>[];
    return value.split('\n');
  }

  @override
  Future<void> save(List<String> lines) async {
    if (lines.isEmpty) {
      await _store.remove(key);
    } else {
      await _store.setString(key, lines.join('\n'));
    }
  }
}
