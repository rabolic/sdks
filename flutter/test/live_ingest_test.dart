// Sends real events to a running Rabolic ingest. Skipped unless
// RABOLIC_LIVE_INGEST (for example http://localhost:4100) and
// RABOLIC_LIVE_KEY (a publishable key) are set:
//   RABOLIC_LIVE_INGEST=http://localhost:4100 RABOLIC_LIVE_KEY=rb_pub_… \
//     flutter test test/live_ingest_test.dart
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:rabolic_flutter/rabolic_flutter.dart';
import 'package:rabolic_flutter/src/platform.dart';
import 'package:rabolic_flutter/src/services.dart';
import 'package:rabolic_flutter/src/storage/file_queue_store.dart';
import 'package:rabolic_flutter/src/storage/key_value_store.dart';

import 'support/harness.dart';

void main() {
  final host = Platform.environment['RABOLIC_LIVE_INGEST'];
  final key = Platform.environment['RABOLIC_LIVE_KEY'];

  test(
    'delivers screen, identify and track events to a live ingest',
    () async {
      final dir = Directory.systemTemp.createTempSync('rabolic_live');
      final client = RabolicClient.withServices(
        RabolicConfig(projectKey: key!, host: host!, trackLifecycle: false),
        RabolicServices(
          platform: RabolicPlatform.android,
          keyValueStore: MemoryKeyValueStore(),
          queueStore: FileQueueStore(() async => dir),
          contextLoader: FakeContextLoader(),
          lifecycle: FakeLifecycle(),
          httpClient: http.Client(),
          ownsHttpClient: true,
        ),
      );
      await client.ready;
      client.screen('LiveCheckScreen');
      client.identify('flutter-live-user', traits: {'plan': 'pro'});
      client.track('live_check', properties: {'sdk': 'flutter'});
      await client.flush();
      // ignore: avoid_print
      print('anonymous_id=${client.anonymousId}');
      await client.close();
      // Everything was accepted: the queue written on close is empty.
      expect(await FileQueueStore(() async => dir).load(), isEmpty);
      dir.deleteSync(recursive: true);
    },
    skip: host == null || key == null ? 'set RABOLIC_LIVE_INGEST and RABOLIC_LIVE_KEY' : false,
  );
}
