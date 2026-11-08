import 'key_value_store.dart';
import 'queue_store.dart';

/// The queue store for the web: `localStorage` through [keyValueStore],
/// which itself falls back to memory.
QueueStore createDefaultQueueStore(KeyValueStore keyValueStore) =>
    KeyValueQueueStore(keyValueStore);
