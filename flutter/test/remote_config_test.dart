import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:rabolic_flutter/src/remote_config.dart';
import 'package:rabolic_flutter/src/storage/key_value_store.dart';
import 'package:rabolic_flutter/src/storage/queue_store.dart';

import 'support/harness.dart';

http.Response configJson(Map<String, Object?> json) =>
    http.Response(jsonEncode(json), 200);

void main() {
  test('is fetched once at start with the key as a query parameter', () {
    runFake((async) {
      final h = startHarness(async, config: manualFlushConfig());
      expect(h.configRequests, hasLength(1));
      final url = h.configRequests.single.request.url;
      expect(url.toString(), startsWith('https://ingest.test/v1/config?'));
      expect(url.queryParameters['key'], testKey);
    });
  });

  test('tracking does not wait for it', () {
    runFake((async) {
      final h = Harness(async: async, config: manualFlushConfig());
      h.configResponder = (_) => Future<http.Response>.delayed(
        const Duration(seconds: 30),
        () => configJson({}),
      );
      h.client.track('a');
      async.elapse(const Duration(seconds: 1));
      expect(h.names, ['a']);
    });
  });

  test('enabled: false clears the queue and stops sending', () {
    runFake((async) {
      final queueStore = MemoryQueueStore();
      final h = Harness(
        async: async,
        config: manualFlushConfig(),
        queueStore: queueStore,
        configResponder: (_) => Future<http.Response>.delayed(
          const Duration(seconds: 1),
          () => configJson({'enabled': false}),
        ),
      );
      async.flushMicrotasks(); // started; the config is still on its way
      h.client.track('before_config');
      async.flushMicrotasks();
      expect(queueStore.lines, hasLength(1));
      async.elapse(const Duration(seconds: 1));
      expect(h.queued, isEmpty);
      expect(queueStore.lines, isEmpty);
      h.client.track('after_config');
      h.client.flush();
      async.flushMicrotasks();
      expect(h.queued, isEmpty);
      expect(h.requests, isEmpty);
    });
  });

  test('the cached config applies at the next launch before any fetch', () {
    final store = MemoryKeyValueStore();
    runFake(
      (async) => startHarness(
        async,
        config: manualFlushConfig(),
        store: store,
        configResponder: (_) => configJson({'enabled': false}),
      ),
    );
    runFake((async) {
      final h = Harness(
        async: async,
        config: manualFlushConfig(),
        store: store,
        configResponder: (_) => Future<http.Response>.delayed(
          const Duration(hours: 1),
          () => configJson({}),
        ),
      );
      h.client.track('a');
      async.flushMicrotasks();
      expect(h.queued, isEmpty);
    });
  });

  test('blockedEvents are dropped before queueing', () {
    runFake((async) {
      final h = startHarness(
        async,
        config: manualFlushConfig(),
        configResponder: (_) => configJson({
          'blockedEvents': ['debug_ping'],
        }),
      );
      h.client.track('debug_ping');
      h.client.track('kept');
      async.flushMicrotasks();
      expect(h.queuedNames, ['kept']);
    });
  });

  test('sampleRate 0 sends nothing; sampleRate 1 sends everything', () {
    runFake((async) {
      final h = startHarness(
        async,
        config: manualFlushConfig(),
        configResponder: (_) => configJson({'sampleRate': 0}),
      );
      h.client.track('a');
      async.flushMicrotasks();
      expect(h.queued, isEmpty);
    });
    runFake((async) {
      final h = startHarness(
        async,
        config: manualFlushConfig(),
        configResponder: (_) => configJson({'sampleRate': 1}),
      );
      h.client.track('a');
      async.flushMicrotasks();
      expect(h.queuedNames, ['a']);
    });
  });

  test('sampling is hash(anonymous_id) / 2^32 < rate, stable per device', () {
    const rate = 0.5;
    var kept = 0;
    for (var i = 0; i < 40; i++) {
      final store = MemoryKeyValueStore();
      bool? first;
      for (var launch = 0; launch < 2; launch++) {
        runFake((async) {
          final h = startHarness(
            async,
            config: manualFlushConfig(),
            store: store,
            configResponder: (_) => configJson({'sampleRate': rate}),
          );
          h.client.track('a');
          async.flushMicrotasks();
          final sampledIn = h.queued.isNotEmpty;
          final expected = fnv1a32(h.client.anonymousId!) / 4294967296 < rate;
          expect(sampledIn, expected);
          if (launch == 0) {
            first = sampledIn;
          } else {
            expect(sampledIn, first, reason: 'decision must be stable');
          }
        });
      }
      if (first!) kept++;
    }
    expect(kept, inInclusiveRange(8, 32));
  });

  test('a 401 from config stops sending like a batch 401', () {
    runFake((async) {
      final h = startHarness(
        async,
        config: manualFlushConfig(),
        configResponder: (_) => http.Response('{"error":"invalid_key"}', 401),
      );
      h.client.track('a');
      h.client.flush();
      async.elapse(const Duration(minutes: 5));
      expect(h.requests, isEmpty);
      expect(h.queuedNames, ['a']);
    });
  });

  test('is refetched on foreground once older than 5 minutes', () {
    runFake((async) {
      final h = startHarness(async, config: manualFlushConfig());
      h.lifecycle.background();
      h.advanceClock(const Duration(minutes: 2));
      h.lifecycle.foreground();
      async.flushMicrotasks();
      expect(h.configRequests, hasLength(1));
      h.lifecycle.background();
      h.advanceClock(const Duration(minutes: 4));
      h.lifecycle.foreground();
      async.flushMicrotasks();
      expect(h.configRequests, hasLength(2));
    });
  });

  test('malformed fields fall back to the defaults', () {
    final config = RemoteConfig.fromJson({
      'enabled': 'yes',
      'sessionBackgroundSec': -5,
      'sampleRate': 7,
      'blockedEvents': ['a', 3],
      'autocapture': 'nope',
    });
    expect(config.enabled, isTrue);
    expect(config.sessionBackgroundSec, 30);
    expect(config.sampleRate, 1);
    expect(config.blockedEvents, {'a'});
    expect(config.lifecycle, isTrue);
  });
}
