import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:rabolic_flutter/src/ids.dart';
import 'package:rabolic_flutter/src/platform.dart';
import 'package:rabolic_flutter/src/storage/key_value_store.dart';

import 'support/harness.dart';

String sessionOf(Map<String, Object?> event) => event['session_id']! as String;

void main() {
  group('mobile sessions', () {
    test('a session starts at launch, with its start time in the id', () {
      runFake((async) {
        final h = startHarness(async, config: manualFlushConfig());
        h.client.track('a');
        async.flushMicrotasks();
        final session = sessionOf(h.events.single);
        expect(uuidV7Time(session), h.base);
      });
    });

    test('every launch starts a new session', () {
      final store = MemoryKeyValueStore();
      final sessions = <String>[];
      for (var i = 0; i < 2; i++) {
        runFake((async) {
          final h = startHarness(
            async,
            config: manualFlushConfig(),
            store: store,
          );
          h.client.track('a');
          async.flushMicrotasks();
          sessions.add(sessionOf(h.events.last));
        });
      }
      expect(sessions[0], isNot(sessions[1]));
    });

    test('30 s or less in the background keeps the session', () {
      runFake((async) {
        final h = startHarness(async, config: manualFlushConfig());
        h.client.track('before');
        h.lifecycle.background();
        h.advanceClock(const Duration(seconds: 30));
        h.lifecycle.foreground();
        h.client.track('after');
        async.flushMicrotasks();
        expect(sessionOf(h.events.first), sessionOf(h.events.last));
      });
    });

    test('more than 30 s in the background starts a new session', () {
      runFake((async) {
        final h = startHarness(async, config: manualFlushConfig());
        h.client.track('before');
        h.lifecycle.background();
        h.advanceClock(const Duration(seconds: 31));
        h.lifecycle.foreground();
        h.client.track('after');
        async.flushMicrotasks();
        final after = sessionOf(h.events.last);
        expect(after, isNot(sessionOf(h.events.first)));
        expect(uuidV7Time(after), h.now());
      });
    });

    test('foreground time never ends a session', () {
      runFake((async) {
        final h = startHarness(async, config: manualFlushConfig());
        h.client.track('a');
        h.advanceClock(const Duration(hours: 5));
        h.client.track('b');
        async.flushMicrotasks();
        expect(sessionOf(h.events.first), sessionOf(h.events.last));
      });
    });

    test('remote config sessionBackgroundSec overrides the 30 s default', () {
      runFake((async) {
        final h = startHarness(
          async,
          config: manualFlushConfig(),
          configResponder: (_) =>
              http.Response(jsonEncode({'sessionBackgroundSec': 120}), 200),
        );
        h.client.track('before');
        h.lifecycle.background();
        h.advanceClock(const Duration(seconds: 90));
        h.lifecycle.foreground();
        h.client.track('after');
        async.flushMicrotasks();
        expect(sessionOf(h.events.first), sessionOf(h.events.last));
      });
    });

    test('reset() starts a new session', () {
      runFake((async) {
        final h = startHarness(async, config: manualFlushConfig());
        h.client.track('a');
        h.client.reset();
        h.client.track('b');
        async.flushMicrotasks();
        expect(sessionOf(h.events.first), isNot(sessionOf(h.events.last)));
      });
    });
  });

  group('web sessions', () {
    test('30 minutes of inactivity starts a new session', () {
      runFake((async) {
        final h = startHarness(
          async,
          config: manualFlushConfig(),
          platform: RabolicPlatform.web,
        );
        h.client.track('a');
        h.advanceClock(const Duration(minutes: 29));
        h.client.track('b');
        h.advanceClock(const Duration(minutes: 30, seconds: 1));
        h.client.track('c');
        async.flushMicrotasks();
        final sessions = h.events.map(sessionOf).toList();
        expect(sessions[0], sessions[1]);
        expect(sessions[2], isNot(sessions[1]));
      });
    });

    test('a reload within the timeout keeps the stored session', () {
      final store = MemoryKeyValueStore();
      final sessions = <String>[];
      for (var i = 0; i < 2; i++) {
        runFake((async) {
          final h = startHarness(
            async,
            config: manualFlushConfig(),
            platform: RabolicPlatform.web,
            store: store,
            clockOffset: Duration(minutes: 10 * i),
          );
          h.client.track('a');
          async.flushMicrotasks();
          sessions.add(sessionOf(h.events.last));
        });
      }
      expect(sessions[0], sessions[1]);
    });

    test('landing with different campaign parameters starts a new session', () {
      final store = MemoryKeyValueStore();
      final sessions = <String>[];
      final landings = [
        Uri.parse('https://app.test/?utm_source=google'),
        Uri.parse('https://app.test/?utm_source=google'),
        Uri.parse('https://app.test/?utm_source=newsletter'),
      ];
      for (final (i, landing) in landings.indexed) {
        runFake((async) {
          final h = startHarness(
            async,
            config: manualFlushConfig(),
            platform: RabolicPlatform.web,
            store: store,
            landingUri: landing,
            clockOffset: Duration(minutes: i),
          );
          h.client.track('a');
          async.flushMicrotasks();
          sessions.add(sessionOf(h.events.last));
        });
      }
      expect(sessions[0], sessions[1]);
      expect(sessions[2], isNot(sessions[1]));
    });
  });
}
