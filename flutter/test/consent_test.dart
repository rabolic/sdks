import 'package:flutter_test/flutter_test.dart';
import 'package:rabolic_flutter/rabolic_flutter.dart';
import 'package:rabolic_flutter/src/storage/key_value_store.dart';
import 'package:rabolic_flutter/src/storage/queue_store.dart';

import 'support/harness.dart';

void main() {
  test('pending keeps events in memory only and sends nothing', () {
    runFake((async) {
      final queueStore = MemoryQueueStore();
      final h = startHarness(
        async,
        config: manualFlushConfig(consent: RabolicConsent.pending),
        queueStore: queueStore,
      );
      h.client.track('a');
      h.client.flush();
      h.lifecycle.background();
      async.elapse(const Duration(minutes: 1));
      expect(h.requests, isEmpty);
      expect(h.queuedNames, ['a']);
      expect(queueStore.lines, isEmpty);
    });
  });

  test('granting consent sends what was kept while pending', () {
    runFake((async) {
      final h = startHarness(
        async,
        config: manualFlushConfig(consent: RabolicConsent.pending),
      );
      h.client.track('a');
      h.client.setConsent(RabolicConsent.granted);
      async.flushMicrotasks();
      expect(h.sentNames, ['a']);
    });
  });

  test('denied drops new events and clears the queue', () {
    runFake((async) {
      final queueStore = MemoryQueueStore();
      final h = startHarness(
        async,
        config: manualFlushConfig(consent: RabolicConsent.pending),
        queueStore: queueStore,
      );
      h.client.track('kept_while_pending');
      h.client.setConsent(RabolicConsent.denied);
      h.client.track('after_denied');
      h.client.flush();
      async.flushMicrotasks();
      expect(h.queued, isEmpty);
      expect(h.requests, isEmpty);
      expect(queueStore.lines, isEmpty);
    });
  });

  test('optOut clears the persisted queue; optIn resumes', () {
    runFake((async) {
      final queueStore = MemoryQueueStore();
      final h = startHarness(
        async,
        config: manualFlushConfig(),
        queueStore: queueStore,
      );
      h.client.track('a');
      async.flushMicrotasks();
      expect(queueStore.lines, hasLength(1));
      h.client.optOut();
      async.flushMicrotasks();
      expect(queueStore.lines, isEmpty);
      expect(h.client.consent, RabolicConsent.denied);

      h.client.optIn();
      h.client.track('b');
      h.client.flush();
      async.flushMicrotasks();
      expect(h.sentNames, ['b']);
    });
  });

  test('a runtime choice is remembered and wins over config next launch', () {
    final store = MemoryKeyValueStore();
    runFake((async) {
      final h = startHarness(async, config: manualFlushConfig(), store: store);
      h.client.optOut();
      async.flushMicrotasks();
    });
    runFake((async) {
      final h = startHarness(async, config: manualFlushConfig(), store: store);
      expect(h.client.consent, RabolicConsent.denied);
      h.client.track('a');
      async.flushMicrotasks();
      expect(h.queued, isEmpty);
    });
  });

  test('a queue from a granted launch is cleared when denied at start', () {
    final store = MemoryKeyValueStore();
    final queueStore = MemoryQueueStore();
    runFake((async) {
      final h = startHarness(
        async,
        config: manualFlushConfig(),
        store: store,
        queueStore: queueStore,
      );
      h.client.track('a');
      async.flushMicrotasks();
    });
    runFake((async) {
      startHarness(
        async,
        config: manualFlushConfig(consent: RabolicConsent.denied),
        store: store,
        queueStore: queueStore,
      );
      async.flushMicrotasks();
      expect(queueStore.lines, isEmpty);
    });
  });
}
