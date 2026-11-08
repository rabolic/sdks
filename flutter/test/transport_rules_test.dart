import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:rabolic_flutter/rabolic_flutter.dart';
import 'package:rabolic_flutter/src/platform.dart';
import 'package:rabolic_flutter/src/storage/key_value_store.dart';
import 'package:rabolic_flutter/src/storage/queue_store.dart';
import 'package:rabolic_flutter/src/version.dart';

import 'support/harness.dart';

void main() {
  group('response rules', () {
    test('200 removes the batch from the queue', () {
      runFake((async) {
        final h = startHarness(async, config: manualFlushConfig());
        h.client.track('a');
        h.client.track('b');
        h.client.flush();
        async.flushMicrotasks();
        expect(h.sentNames, <String>['a', 'b']);
        expect(h.queued, isEmpty);
      });
    });

    test('400 drops the batch without retrying', () {
      runFake((async) {
        final h = startHarness(
          async,
          config: manualFlushConfig(),
          batchResponder: (_) =>
              http.Response('{"error":"invalid_batch","message":"bad"}', 400),
        );
        h.client.track('a');
        h.client.flush();
        async.flushMicrotasks();
        expect(h.queued, isEmpty);
        async.elapse(const Duration(minutes: 10));
        expect(h.requests, hasLength(1));
      });
    });

    test('other 4xx drop the batch without retrying', () {
      runFake((async) {
        final h = startHarness(
          async,
          config: manualFlushConfig(),
          batchResponder: (_) => status(403),
        );
        h.client.track('a');
        h.client.flush();
        async.elapse(const Duration(minutes: 10));
        expect(h.requests, hasLength(1));
        expect(h.queued, isEmpty);
      });
    });

    test('401 stops sending for the process, keeps the queue, logs once', () {
      runFake((async) {
        final h = startHarness(
          async,
          config: manualFlushConfig(),
          batchResponder: (_) => http.Response('{"error":"invalid_key"}', 401),
        );
        h.client.track('a');
        h.client.flush();
        async.flushMicrotasks();
        h.client.track('b');
        h.client.flush();
        async.elapse(const Duration(hours: 1));
        expect(h.requests, hasLength(1));
        expect(h.queuedNames, <String>['a', 'b']);
        expect(h.logs.where((l) => l.contains('401')), hasLength(1));
      });
    });

    test('a queue kept after 401 is sent by the next process', () {
      final store = MemoryKeyValueStore();
      final queueStore = MemoryQueueStore();
      runFake((async) {
        final h = startHarness(
          async,
          config: manualFlushConfig(),
          store: store,
          queueStore: queueStore,
          batchResponder: (_) => status(401),
        );
        h.client.track('a');
        h.client.flush();
        async.flushMicrotasks();
        h.client.close();
        async.flushMicrotasks();
      });
      runFake((async) {
        final h = startHarness(
          async,
          config: manualFlushConfig(),
          store: store,
          queueStore: queueStore,
        );
        h.client.flush();
        async.flushMicrotasks();
        expect(h.sentNames, <String>['a']);
      });
    });

    test('413 splits the batch in half and retries each half', () {
      runFake((async) {
        final h = startHarness(
          async,
          config: manualFlushConfig(),
          batchResponder: (r) => r.events.length > 2 ? status(413) : ok(),
        );
        for (var i = 0; i < 5; i++) {
          h.client.track('e$i');
        }
        h.client.flush();
        async.flushMicrotasks();
        final sizes = h.requests.map((r) => r.events.length).toList();
        // 5 → 2 + 3; 3 → 1 + 2.
        expect(sizes, <int>[5, 2, 3, 1, 2]);
        expect(
          h.requests
              .where((r) => r.events.length <= 2)
              .expand((r) => r.eventNames),
          <String>['e0', 'e1', 'e2', 'e3', 'e4'],
        );
        expect(h.queued, isEmpty);
      });
    });

    test('413 for a single event drops it and carries on', () {
      runFake((async) {
        final h = startHarness(
          async,
          config: manualFlushConfig(),
          batchResponder: (r) =>
              r.eventNames.contains('huge') ? status(413) : ok(),
        );
        h.client.track('huge');
        h.client.track('fine');
        h.client.flush();
        async.flushMicrotasks();
        expect(h.queued, isEmpty);
        expect(h.requests.last.eventNames, <String>['fine']);
      });
    });

    test('429 retries after Retry-After seconds', () {
      runFake((async) {
        var calls = 0;
        final h = startHarness(
          async,
          config: manualFlushConfig(),
          batchResponder: (_) =>
              ++calls == 1 ? status(429, headers: {'retry-after': '7'}) : ok(),
        );
        h.client.track('a');
        h.client.flush();
        async.elapse(const Duration(milliseconds: 6900));
        expect(h.requests, hasLength(1));
        async.elapse(const Duration(milliseconds: 200));
        expect(h.requests, hasLength(2));
        expect(h.queued, isEmpty);
      });
    });

    test('5xx retries with exponential backoff, reset after a 200', () {
      runFake((async) {
        var failing = true;
        final h = startHarness(
          async,
          config: manualFlushConfig(),
          // nextDouble() = 0 → jitter 0.5, so delays are 0.5 s, 1 s, 2 s …
          randomValue: 0,
          batchResponder: (_) => failing ? status(503) : ok(),
        );
        final sendTimes = <Duration>[];
        h.batchResponder = (_) {
          sendTimes.add(async.elapsed);
          return failing ? status(503) : ok();
        };
        h.client.track('a');
        h.client.flush();
        async.elapse(const Duration(seconds: 4));
        expect(sendTimes, <Duration>[
          Duration.zero,
          const Duration(milliseconds: 500),
          const Duration(milliseconds: 1500),
          const Duration(milliseconds: 3500),
        ]);

        failing = false;
        async.elapse(const Duration(seconds: 4));
        expect(h.queued, isEmpty);

        // After the 200, the next failure starts from 0.5 s again.
        failing = true;
        sendTimes.clear();
        final start = async.elapsed;
        h.client.track('b');
        h.client.flush();
        async.elapse(const Duration(seconds: 1));
        expect(sendTimes.map((t) => t - start), <Duration>[
          Duration.zero,
          const Duration(milliseconds: 500),
        ]);
      });
    });

    test('backoff is capped at 300 s and jittered between 50 and 100 %', () {
      runFake((async) {
        final sendTimes = <Duration>[];
        final h = startHarness(
          async,
          config: manualFlushConfig(),
          randomValue: 0.999999,
        );
        h.batchResponder = (_) {
          sendTimes.add(async.elapsed);
          return status(500);
        };
        h.client.track('a');
        h.client.flush();
        async.elapse(const Duration(hours: 1));
        final gaps = <int>[
          for (var i = 1; i < sendTimes.length; i++)
            (sendTimes[i] - sendTimes[i - 1]).inMilliseconds,
        ];
        expect(gaps.first, closeTo(1000, 1));
        expect(gaps[1], closeTo(2000, 1));
        expect(gaps.reduce((a, b) => a > b ? a : b), closeTo(300000, 1));
      });
    });

    test('network errors and timeouts are retried', () {
      runFake((async) {
        var calls = 0;
        final h = startHarness(async, config: manualFlushConfig());
        h.batchResponder = (_) {
          calls++;
          if (calls == 1) throw http.ClientException('offline');
          if (calls == 2) return Completer<http.Response>().future;
          return ok();
        };
        h.client.track('a');
        h.client.flush();
        async.flushMicrotasks();
        expect(h.queued, hasLength(1));
        async.elapse(const Duration(seconds: 1)); // backoff → hangs
        expect(calls, 2);
        async.elapse(const Duration(seconds: 10)); // 10 s timeout
        async.elapse(const Duration(seconds: 2)); // backoff → 200
        expect(calls, 3);
        expect(h.queued, isEmpty);
      });
    });

    test('a retried batch keeps its event ids and gets a new sent_at', () {
      runFake((async) {
        var calls = 0;
        final h = startHarness(
          async,
          config: manualFlushConfig(),
          batchResponder: (_) => ++calls == 1 ? status(500) : ok(),
        );
        h.client.track('a');
        h.client.flush();
        async.elapse(const Duration(seconds: 2));
        expect(h.requests, hasLength(2));
        final first = h.requests[0].json;
        final second = h.requests[1].json;
        expect(
          h.requests[1].events.single['event_id'],
          h.requests[0].events.single['event_id'],
        );
        expect(second['sent_at'], isNot(first['sent_at']));
      });
    });
  });

  group('batching', () {
    test('only one request is in flight at a time', () {
      runFake((async) {
        final pending = <Completer<http.Response>>[];
        var inFlight = 0;
        var maxInFlight = 0;
        final h = startHarness(async, config: manualFlushConfig());
        h.batchResponder = (_) {
          inFlight++;
          maxInFlight = inFlight > maxInFlight ? inFlight : maxInFlight;
          final completer = Completer<http.Response>();
          pending.add(completer);
          return completer.future.whenComplete(() => inFlight--);
        };
        h.client.track('a');
        h.client.flush();
        async.flushMicrotasks();
        h.client.track('b');
        h.client.flush();
        h.client.flush();
        async.flushMicrotasks();
        expect(pending, hasLength(1));

        pending.removeAt(0).complete(ok());
        async.flushMicrotasks();
        // The running flush picks up "b" when "a" is done.
        expect(pending, hasLength(1));
        expect(h.requests.last.eventNames, <String>['b']);
        pending.removeAt(0).complete(ok());
        async.flushMicrotasks();
        expect(maxInFlight, 1);
        expect(h.queued, isEmpty);
      });
    });

    test('flushes when flushAt events are queued', () {
      runFake((async) {
        final h = startHarness(
          async,
          config: const RabolicConfig(
            projectKey: testKey,
            flushAt: 3,
            flushInterval: Duration(days: 1),
            trackLifecycle: false,
          ),
        );
        h.client.track('a');
        h.client.track('b');
        async.flushMicrotasks();
        expect(h.requests, isEmpty);
        h.client.track('c');
        async.flushMicrotasks();
        expect(h.sentNames, <String>['a', 'b', 'c']);
      });
    });

    test('flushes every flushInterval', () {
      runFake((async) {
        final h = startHarness(
          async,
          config: const RabolicConfig(
            projectKey: testKey,
            flushInterval: Duration(seconds: 15),
            trackLifecycle: false,
          ),
        );
        async.flushMicrotasks();
        h.client.track('a');
        async.elapse(const Duration(seconds: 14));
        expect(h.requests, isEmpty);
        async.elapse(const Duration(seconds: 1));
        expect(h.sentNames, <String>['a']);
      });
    });

    test('a batch holds at most 500 events, in creation order', () {
      runFake((async) {
        final h = startHarness(async, config: manualFlushConfig());
        for (var i = 0; i < 1201; i++) {
          h.client.track('e$i');
        }
        h.client.flush();
        async.flushMicrotasks();
        expect(h.requests.map((r) => r.events.length), <int>[500, 500, 201]);
        expect(h.sentNames, <String>[for (var i = 0; i < 1201; i++) 'e$i']);
      });
    });

    test('a batch holds at most 900 KB', () {
      runFake((async) {
        final h = startHarness(async, config: manualFlushConfig());
        final filler = 'x' * (30 * 1024);
        for (var i = 0; i < 40; i++) {
          h.client.track('big', properties: <String, Object?>{'f': filler});
        }
        h.client.flush();
        async.flushMicrotasks();
        for (final request in h.requests) {
          final eventBytes = request.events
              .map((e) => utf8.encode(jsonEncode(e)).length)
              .reduce((a, b) => a + b);
          expect(eventBytes, lessThanOrEqualTo(900 * 1024));
        }
        expect(h.requests.length, greaterThan(1));
        expect(h.sentEvents, hasLength(40));
      });
    });
  });

  group('request format', () {
    test('mobile: bearer key, JSON, gzip above 1 KB', () {
      runFake((async) {
        final h = startHarness(async, config: manualFlushConfig());
        h.client.track('small');
        h.client.flush();
        async.flushMicrotasks();
        var request = h.requests.single;
        expect(request.headers['Authorization'], 'Bearer $testKey');
        expect(request.headers['Content-Type'], startsWith('application/json'));
        expect(request.headers['Content-Encoding'], isNull);
        expect(request.json.containsKey('key'), isFalse);
        expect(request.json['library'], <String, Object?>{
          'name': libraryName,
          'version': libraryVersion,
        });

        h.client.track('large', properties: {'text': 'y' * 2000});
        h.client.flush();
        async.flushMicrotasks();
        request = h.requests.last;
        expect(request.headers['Content-Encoding'], 'gzip');
        expect(request.eventNames, <String>['large']);
      });
    });

    test('web: key in the body, text/plain, never gzip', () {
      runFake((async) {
        final h = startHarness(
          async,
          config: manualFlushConfig(),
          platform: RabolicPlatform.web,
        );
        h.client.track('large', properties: {'text': 'y' * 2000});
        h.client.flush();
        async.flushMicrotasks();
        final request = h.requests.single;
        expect(request.headers['Authorization'], isNull);
        expect(request.headers['Content-Type'], 'text/plain;charset=UTF-8');
        expect(request.headers['Content-Encoding'], isNull);
        expect(request.json['key'], testKey);
      });
    });

    test('sent_at is the send time, not the event time', () {
      runFake((async) {
        final h = startHarness(async, config: manualFlushConfig());
        h.client.track('a');
        async.elapse(const Duration(seconds: 3));
        h.client.flush();
        async.flushMicrotasks();
        final request = h.requests.single;
        expect(request.json['sent_at'], '2026-11-08T10:00:03.000Z');
        expect(request.events.single['timestamp'], '2026-11-08T10:00:00.000Z');
      });
    });
  });
}
