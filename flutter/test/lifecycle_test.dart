import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:rabolic_flutter/src/platform.dart';
import 'package:rabolic_flutter/src/storage/key_value_store.dart';

import 'support/harness.dart';

Map<String, Object?> props(Map<String, Object?> event) =>
    (event['properties'] as Map<String, Object?>?) ?? const {};

void main() {
  final lifecycleConfig = manualFlushConfig(trackLifecycle: true);

  test('first launch sends \$app_first_open, then \$app_open', () {
    runFake((async) {
      final h = startHarness(async, config: lifecycleConfig);
      expect(h.names, [r'$app_first_open', r'$app_open']);
      expect(props(h.events.last), {'from_background': false});
    });
  });

  test('a later launch on the same version sends only \$app_open', () {
    final store = MemoryKeyValueStore();
    runFake(
      (async) => startHarness(async, config: lifecycleConfig, store: store),
    );
    runFake((async) {
      final h = startHarness(async, config: lifecycleConfig, store: store);
      expect(h.names, [r'$app_open']);
    });
  });

  test('a new app version sends \$app_update with previous_version', () {
    final store = MemoryKeyValueStore();
    runFake(
      (async) => startHarness(
        async,
        config: lifecycleConfig,
        store: store,
        appVersion: '1.0.0',
      ),
    );
    runFake((async) {
      final h = startHarness(
        async,
        config: lifecycleConfig,
        store: store,
        appVersion: '1.1.0',
      );
      expect(h.names, [r'$app_update', r'$app_open']);
      expect(props(h.events.first), {'previous_version': '1.0.0'});
    });
  });

  test('background sends \$app_background with foreground_ms; '
      'background time never counts', () {
    runFake((async) {
      final h = startHarness(async, config: lifecycleConfig);
      h.advanceClock(const Duration(seconds: 12, milliseconds: 345));
      h.lifecycle.background();
      h.advanceClock(const Duration(minutes: 10)); // in the background
      h.lifecycle.foreground();
      h.advanceClock(const Duration(seconds: 5));
      h.lifecycle.background();
      async.flushMicrotasks();

      final names = h.names;
      expect(names, [
        r'$app_first_open',
        r'$app_open',
        r'$app_background',
        r'$app_open',
        r'$app_background',
      ]);
      expect(props(h.events[2]), {'foreground_ms': 12345});
      expect(props(h.events[3]), {'from_background': true});
      expect(props(h.events[4]), {'foreground_ms': 5000});
    });
  });

  test('repeated lifecycle signals are ignored', () {
    runFake((async) {
      final h = startHarness(async, config: lifecycleConfig);
      h.lifecycle.foreground();
      h.lifecycle.background();
      h.lifecycle.background();
      async.flushMicrotasks();
      expect(h.names.where((n) => n == r'$app_background'), hasLength(1));
      expect(h.names.where((n) => n == r'$app_open'), hasLength(1));
    });
  });

  test('going to the background flushes the queue', () {
    runFake((async) {
      final h = startHarness(async, config: lifecycleConfig);
      h.client.track('a');
      h.lifecycle.background();
      async.flushMicrotasks();
      expect(h.sentNames, [
        r'$app_first_open',
        r'$app_open',
        'a',
        r'$app_background',
      ]);
    });
  });

  test('a launch into the background defers \$app_open until shown', () {
    runFake((async) {
      final h = startHarness(
        async,
        config: lifecycleConfig,
        startsInForeground: false,
      );
      expect(h.names, [r'$app_first_open']);
      h.advanceClock(const Duration(seconds: 3));
      h.lifecycle.foreground();
      h.advanceClock(const Duration(seconds: 2));
      h.lifecycle.background();
      async.flushMicrotasks();
      expect(h.names, [r'$app_first_open', r'$app_open', r'$app_background']);
      expect(props(h.events[1]), {'from_background': false});
      expect(props(h.events[2]), {'foreground_ms': 2000});
    });
  });

  test('trackLifecycle: false sends no lifecycle events', () {
    runFake((async) {
      final h = startHarness(async, config: manualFlushConfig());
      h.lifecycle.background();
      h.lifecycle.foreground();
      async.flushMicrotasks();
      expect(h.events, isEmpty);
    });
  });

  test('remote autocapture.lifecycle: false turns lifecycle events off', () {
    final store = MemoryKeyValueStore();
    runFake((async) {
      final h = startHarness(
        async,
        config: lifecycleConfig,
        store: store,
        configResponder: (_) => http.Response(
          jsonEncode({
            'autocapture': {'lifecycle': false},
          }),
          200,
        ),
      );
      h.lifecycle.background();
      h.lifecycle.foreground();
      async.flushMicrotasks();
      // The launch events predate the config; nothing after it.
      expect(h.names, [r'$app_first_open', r'$app_open']);
    });
    runFake((async) {
      // The cached config applies from the next launch's first event.
      final h = startHarness(async, config: lifecycleConfig, store: store);
      expect(h.events, isEmpty);
    });
  });

  test('the web sends no app lifecycle events', () {
    runFake((async) {
      final h = startHarness(
        async,
        config: lifecycleConfig,
        platform: RabolicPlatform.web,
      );
      h.lifecycle.background();
      h.lifecycle.foreground();
      async.flushMicrotasks();
      expect(h.events, isEmpty);
    });
  });
}
