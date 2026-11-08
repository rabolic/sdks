import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:rabolic_flutter/rabolic_flutter.dart';
import 'package:rabolic_flutter/src/logger.dart';
import 'package:rabolic_flutter/src/platform.dart';
import 'package:rabolic_flutter/src/services.dart';
import 'package:rabolic_flutter/src/storage/key_value_store.dart';
import 'package:rabolic_flutter/src/storage/queue_store.dart';

import 'support/harness.dart';

void main() {
  tearDown(() => Rabolic.instance = null);

  test('static calls before init do nothing and never throw', () async {
    expect(Rabolic.instance, isNull);
    expect(() {
      Rabolic.track('a');
      Rabolic.screen('Home');
      Rabolic.identify('u');
      Rabolic.reset();
      Rabolic.register({'a': 1});
      Rabolic.unregister('a');
      Rabolic.setConsent(RabolicConsent.denied);
      Rabolic.optIn();
      Rabolic.optOut();
      Rabolic.handleDeepLink(Uri.parse('x://y'));
    }, returnsNormally);
    await Rabolic.flush();
    expect(Rabolic.anonymousId, isNull);
    expect(Rabolic.appAccountToken, isNull);
  });

  test('static calls go to the installed client', () async {
    final h = Harness(config: manualFlushConfig());
    Rabolic.instance = h.client;
    await h.client.ready;
    Rabolic.track('a');
    Rabolic.screen('Home');
    Rabolic.identify('usr_1');
    expect(Rabolic.anonymousId, h.client.anonymousId);
    expect(Rabolic.appAccountToken, h.client.appAccountToken);
    await Rabolic.flush();
    expect(h.sentNames, ['a', r'$screen', r'$identify']);
    await Rabolic.close();
    expect(Rabolic.instance, isNull);
  });

  test(
    'calls made before the client is ready keep their order and time',
    () async {
      final h = Harness(config: manualFlushConfig());
      h.client.track('first');
      h.client.identify('usr_1');
      h.client.track('second');
      expect(h.client.anonymousId, isNull);
      await h.client.ready;
      await h.client.flush();
      expect(h.sentNames, ['first', r'$identify', 'second']);
      expect(h.sentEvents.last['user_id'], 'usr_1');
      expect(h.sentEvents.first.containsKey('user_id'), isFalse);
      await h.client.close();
    },
  );

  test('desktop is a no-op that logs once', () async {
    final logs = <String>[];
    var requests = 0;
    final client = RabolicClient.withServices(
      const RabolicConfig(projectKey: testKey),
      RabolicServices(
        platform: RabolicPlatform.unsupported,
        keyValueStore: MemoryKeyValueStore(),
        queueStore: MemoryQueueStore(),
        contextLoader: FakeContextLoader(),
        lifecycle: FakeLifecycle(),
        httpClient: MockClient((_) async {
          requests++;
          return http.Response('{}', 200);
        }),
        logSink: logs.add,
      ),
    );
    await client.ready;
    client.track('a');
    client.identify('u');
    await client.flush();
    expect(client.anonymousId, isNull);
    expect(requests, 0);
    expect(logs, hasLength(1));
    expect(logs.single, contains('not supported'));
  });

  test('the project key never appears in logs', () async {
    final h = Harness(
      config: RabolicConfig(
        projectKey: testKey,
        host: 'https://ingest.test',
        debug: true,
        flushAt: 1,
      ),
      batchResponder: (_) => http.Response('{"error":"invalid_key"}', 401),
      configResponder: (_) => http.Response('{"error":"invalid_key"}', 401),
    );
    await h.client.ready;
    h.client.track('a', properties: {'echo': testKey});
    h.client.track('bad name\n');
    await h.client.flush();
    await h.client.close();
    expect(h.logs, isNotEmpty);
    for (final line in h.logs) {
      expect(line, isNot(contains(testKey)));
    }
  });

  test('the logger masks the key even if a message contains it', () {
    final lines = <String>[];
    RabolicLogger(
      verbose: true,
      projectKey: testKey,
      sink: lines.add,
    ).debug('url=https://ingest.test/v1/config?key=$testKey');
    expect(lines.single, isNot(contains(testKey)));
    expect(lines.single, contains('<project key>'));
  });

  test('libraryVersion matches pubspec.yaml', () {
    final pubspec = File('pubspec.yaml').readAsStringSync();
    final version = RegExp(
      r'^version:\s*(\S+)',
      multiLine: true,
    ).firstMatch(pubspec)!;
    expect(libraryVersion, version.group(1));
  });
}
