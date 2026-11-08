import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:rabolic_flutter/src/logger.dart';
import 'package:rabolic_flutter/src/queue.dart';
import 'package:rabolic_flutter/src/storage/file_queue_store.dart';
import 'package:rabolic_flutter/src/storage/key_value_store.dart';
import 'package:rabolic_flutter/src/storage/queue_store.dart';

import 'support/harness.dart';

QueuedEvent event(String id, DateTime time) => QueuedEvent(
  id: id,
  timestamp: time,
  json: jsonEncode({'event_id': id, 'timestamp': time.toIso8601String()}),
);

EventQueue newQueue(QueueStore store, {int maxSize = 100, DateTime? now}) =>
    EventQueue(
      store: store,
      maxSize: maxSize,
      clock: () => now ?? DateTime.utc(2026, 11, 8),
      logger: RabolicLogger(verbose: false, projectKey: testKey),
    );

void main() {
  final now = DateTime.utc(2026, 11, 8);

  group('EventQueue', () {
    test('drops the oldest events when full', () async {
      final queue = newQueue(MemoryQueueStore(), maxSize: 3);
      for (var i = 0; i < 5; i++) {
        queue.add(event('e$i', now));
      }
      expect(queue.events.map((e) => e.id), ['e2', 'e3', 'e4']);
    });

    test('drops events older than 7 days', () async {
      final queue = newQueue(MemoryQueueStore(), now: now);
      queue
        ..add(event('old', now.subtract(const Duration(days: 7, seconds: 1))))
        ..add(event('recent', now.subtract(const Duration(days: 6))));
      expect(queue.dropExpired(), 1);
      expect(queue.events.map((e) => e.id), ['recent']);
    });

    test(
      'survives a restart, skipping damaged lines and expired events',
      () async {
        final store = MemoryQueueStore();
        final first = newQueue(store);
        first
          ..add(event('a', now))
          ..add(event('b', now));
        await first.persisted();
        store.lines = [
          ...store.lines,
          '{"event_id": "trunc',
          'not json',
          event('old', now.subtract(const Duration(days: 8))).json,
          event('c', now).json,
        ];
        final second = newQueue(store);
        await second.load();
        expect(second.events.map((e) => e.id), ['a', 'b', 'c']);
        await second.persisted();
        expect(store.lines, hasLength(3));
      },
    );

    test('a restored queue larger than maxSize keeps the newest', () async {
      final store = MemoryQueueStore()
        ..lines = [for (var i = 0; i < 10; i++) event('e$i', now).json];
      final queue = newQueue(store, maxSize: 4);
      await queue.load();
      expect(queue.events.map((e) => e.id), ['e6', 'e7', 'e8', 'e9']);
    });

    test('coalesces many changes into few writes', () async {
      final store = _CountingStore();
      final queue = newQueue(store);
      for (var i = 0; i < 100; i++) {
        queue.add(event('e$i', now));
      }
      await queue.persisted();
      expect(store.saves, 1);
      expect(store.lines, hasLength(100));
    });
  });

  group('FileQueueStore', () {
    // Each test gets its own directory, captured by value so a save still
    // running from an earlier test can't write into it.
    late Directory dir;
    setUp(() => dir = Directory.systemTemp.createTempSync('rabolic_queue'));
    FileQueueStore storeIn(Directory directory) =>
        FileQueueStore(() async => directory);
    tearDown(() => dir.deleteSync(recursive: true));

    test('round-trips through a file and leaves no temp file', () async {
      final store = storeIn(dir);
      await store.save(['one', 'two']);
      expect(await storeIn(dir).load(), ['one', 'two']);
      expect(dir.listSync().map((f) => f.uri.pathSegments.last), [
        'queue.jsonl',
      ]);
    });

    test('a leftover temp file from a crash does not affect loading', () async {
      final store = storeIn(dir);
      await store.save(['good']);
      File('${dir.path}/queue.jsonl.tmp').writeAsStringSync('half a wri');
      expect(await store.load(), ['good']);
      await store.save(['next']);
      expect(await store.load(), ['next']);
    });

    test('invalid UTF-8 and missing files load as best effort', () async {
      final store = storeIn(dir);
      expect(await store.load(), isEmpty);
      final valid = event('ok', now).json;
      File(
        '${dir.path}/queue.jsonl',
      ).writeAsBytesSync([0xff, 0xfe, 10, ...utf8.encode(valid)]);
      final queue = newQueue(store);
      await queue.load();
      expect(queue.events.map((e) => e.id), ['ok']);
      await queue.persisted();
    });

    test('a client queue survives an app restart', () async {
      final queueStore = storeIn(dir);
      final keyValues = MemoryKeyValueStore();
      final first = Harness(
        config: manualFlushConfig(),
        store: keyValues,
        queueStore: queueStore,
        base: DateTime.now(),
      );
      await first.client.ready;
      first.client.track('before_restart');
      await first.client.close();
      expect(await queueStore.load(), hasLength(1));

      final second = Harness(
        config: manualFlushConfig(),
        store: keyValues,
        queueStore: queueStore,
        base: DateTime.now(),
      );
      // The restored queue is sent as soon as the client starts.
      await second.client.ready;
      await second.client.flush();
      expect(second.sentNames, ['before_restart']);
      await second.client.close();
      expect(await queueStore.load(), isEmpty);
    });
  });

  group('KeyValueQueueStore and fallback storage', () {
    test('stores JSON lines under rb_queue', () async {
      final values = MemoryKeyValueStore();
      final store = KeyValueQueueStore(values);
      await store.save(['a', 'b']);
      expect(values.values['rb_queue'], 'a\nb');
      expect(await store.load(), ['a', 'b']);
      await store.save([]);
      expect(values.values.containsKey('rb_queue'), isFalse);
    });

    test('falls back to memory when the primary store throws', () async {
      final store = FallbackKeyValueStore(_BrokenStore());
      await store.setString('k', 'v');
      expect(await store.getString('k'), 'v');
    });
  });
}

class _CountingStore extends MemoryQueueStore {
  int saves = 0;

  @override
  Future<void> save(List<String> lines) {
    saves++;
    return super.save(lines);
  }
}

class _BrokenStore implements KeyValueStore {
  @override
  Future<String?> getString(String key) => throw StateError('blocked');

  @override
  Future<void> remove(String key) => throw StateError('blocked');

  @override
  Future<void> setString(String key, String value) =>
      throw StateError('blocked');
}
