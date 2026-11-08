import 'package:flutter_test/flutter_test.dart';
import 'package:rabolic_flutter/src/storage/key_value_store.dart';

import 'support/harness.dart';

final _v4 = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
);

void main() {
  test('the anonymous id is a UUIDv4 kept across launches', () {
    final store = MemoryKeyValueStore();
    final ids = <String>[];
    for (var i = 0; i < 2; i++) {
      runFake((async) {
        final h = startHarness(
          async,
          config: manualFlushConfig(),
          store: store,
        );
        ids.add(h.client.anonymousId!);
      });
    }
    expect(ids[0], matches(_v4));
    expect(ids[1], ids[0]);
  });

  test('identify sets user_id on later events and sends \$identify', () {
    runFake((async) {
      final h = startHarness(async, config: manualFlushConfig());
      h.client.track('before');
      h.client.identify('usr_1', traits: {'plan': 'pro'});
      h.client.track('after');
      async.flushMicrotasks();
      expect(h.queuedNames, ['before', r'$identify', 'after']);
      expect(h.queued[0].containsKey('user_id'), isFalse);
      final identify = h.queued[1];
      expect(identify['type'], 'identify');
      expect(identify['user_id'], 'usr_1');
      expect(identify['traits'], {
        'plan': 'pro',
        'app_account_token': h.client.appAccountToken,
      });
      expect(identify.containsKey('properties'), isFalse);
      expect(h.queued[2]['user_id'], 'usr_1');
    });
  });

  test('reset clears the user and makes a new anonymous id', () {
    runFake((async) {
      final h = startHarness(async, config: manualFlushConfig());
      final before = h.client.anonymousId;
      h.client.identify('usr_1');
      h.client.reset();
      h.client.track('after');
      async.flushMicrotasks();
      expect(h.client.anonymousId, isNot(before));
      expect(h.queued.last.containsKey('user_id'), isFalse);
      expect(h.queued.last['anonymous_id'], h.client.anonymousId);
    });
  });

  group('appAccountToken', () {
    test('is null until identify, then a UUID kept across launches', () {
      final store = MemoryKeyValueStore();
      String? token;
      runFake((async) {
        final h = startHarness(
          async,
          config: manualFlushConfig(),
          store: store,
        );
        expect(h.client.appAccountToken, isNull);
        h.client.identify('usr_1');
        async.flushMicrotasks();
        token = h.client.appAccountToken;
        expect(token, matches(_v4));
        h.client.identify('usr_1');
        async.flushMicrotasks();
        expect(h.client.appAccountToken, token);
      });
      runFake((async) {
        final h = startHarness(
          async,
          config: manualFlushConfig(),
          store: store,
        );
        expect(h.client.appAccountToken, token);
      });
    });

    test('changes for a different user and clears on reset', () {
      runFake((async) {
        final h = startHarness(async, config: manualFlushConfig());
        h.client.identify('usr_1');
        async.flushMicrotasks();
        final first = h.client.appAccountToken;
        h.client.identify('usr_2');
        async.flushMicrotasks();
        expect(h.client.appAccountToken, isNot(first));
        h.client.reset();
        async.flushMicrotasks();
        expect(h.client.appAccountToken, isNull);
      });
    });
  });

  group('super properties', () {
    test('are added to events, persisted, and lose to event properties', () {
      final store = MemoryKeyValueStore();
      runFake((async) {
        final h = startHarness(
          async,
          config: manualFlushConfig(),
          store: store,
        );
        h.client.register({'tier': 'gold', 'ab': 'a'});
        async.flushMicrotasks();
      });
      runFake((async) {
        final h = startHarness(
          async,
          config: manualFlushConfig(),
          store: store,
        );
        h.client.track('e', properties: {'ab': 'b'});
        h.client.unregister('tier');
        h.client.track('f');
        async.flushMicrotasks();
        expect(h.queued[0]['properties'], {'tier': 'gold', 'ab': 'b'});
        expect(h.queued[1]['properties'], {'ab': 'a'});
      });
    });

    test('are cleared by reset', () {
      runFake((async) {
        final h = startHarness(async, config: manualFlushConfig());
        h.client.register({'tier': 'gold'});
        h.client.reset();
        h.client.track('e');
        async.flushMicrotasks();
        expect(h.queued.single.containsKey('properties'), isFalse);
      });
    });
  });
}
