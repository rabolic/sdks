import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:json_schema/json_schema.dart';
import 'package:rabolic_flutter/rabolic_flutter.dart';
import 'package:rabolic_flutter/src/platform.dart';

import 'support/harness.dart';

/// The schema the ingest service validates against. Read from the
/// repository's `spec/`, never copied, so it can't drift.
final File schemaFile = File('../spec/schema/batch.schema.json');

late JsonSchema batchSchema;
late JsonSchema eventSchema;

void expectValid(JsonSchema schema, Object? instance) {
  final result = schema.validate(instance);
  expect(
    result.isValid,
    isTrue,
    reason: '${result.errors.join('\n')}\n${jsonEncode(instance)}',
  );
}

/// Drives a client through every kind of event it produces.
List<RecordedRequest> exerciseClient(RabolicPlatform platform) {
  late List<RecordedRequest> requests;
  runFake((async) {
    final h = startHarness(
      async,
      platform: platform,
      config: const RabolicConfig(
        projectKey: testKey,
        host: 'https://ingest.test',
        flushAt: 1000,
        flushInterval: Duration(days: 1),
      ),
      landingUri: platform == RabolicPlatform.web
          ? Uri.parse('https://app.test/?utm_source=x&gclid=1')
          : null,
    );
    h.client.register({
      'tier': 'gold',
      'nested': {
        'a': [1, 2.5, null, true],
      },
    });
    h.client.track(
      'workout_started',
      properties: {
        'program_id': 'strength-30',
        'when': DateTime.utc(2026),
        'tags': ['a', 'b'],
      },
    );
    h.client.screen('HomeScreen', properties: {'tab': 'feed'});
    h.client.screen('x' * 400);
    h.client.identify('usr_8f2k1x9q', traits: {'email_verified': true});
    h.client.handleDeepLink(
      Uri.parse(
        'acme://open?rb_aid=4f1c&utm_source=google&utm_campaign=q4&ttclid=1',
      ),
    );
    h.lifecycle.background();
    h.advanceClock(const Duration(minutes: 2));
    h.lifecycle.foreground();
    h.client.reset();
    h.client.track('after_reset');
    h.client.flush();
    async.flushMicrotasks();
    requests = h.requests;
  });
  return requests;
}

void main() {
  setUpAll(() {
    expect(
      schemaFile.existsSync(),
      isTrue,
      reason: 'run the tests from flutter/ in the rabolic/sdks repository',
    );
    final json = jsonDecode(schemaFile.readAsStringSync()) as Object;
    batchSchema = JsonSchema.create(
      json,
      schemaVersion: SchemaVersion.draft2020_12,
    );
    eventSchema = batchSchema.resolvePath(Uri.parse(r'#/$defs/event'));
  });

  for (final platform in [
    RabolicPlatform.ios,
    RabolicPlatform.android,
    RabolicPlatform.web,
  ]) {
    test('${platform.name} batches conform to batch.schema.json', () {
      final requests = exerciseClient(platform);
      final events = requests.expand((r) => r.events).toList();
      final names = events.map((e) => e['event']).toSet();
      expect(
        names,
        containsAll(<String>[
          'workout_started',
          r'$screen',
          r'$identify',
          r'$deep_link',
          'after_reset',
          if (platform.isMobile) ...[
            r'$app_first_open',
            r'$app_open',
            r'$app_background',
          ],
        ]),
      );
      for (final request in requests) {
        expectValid(batchSchema, request.json);
      }
      for (final event in events) {
        expectValid(eventSchema, event);
        expect((event['context']! as Map)['platform'], platform.name);
        expect(event['session_id'], isNotNull);
      }
    });
  }

  test('the validator rejects what the server would reject', () {
    final event = exerciseClient(RabolicPlatform.ios).first.events.first;
    final badPlatform = {
      ...event,
      'context': {...event['context']! as Map, 'platform': 'macos'},
    };
    final extraField = {...event, 'unexpected': 1};
    final badTimestamp = {...event, 'timestamp': 'yesterday'};
    expect(eventSchema.validate(badTimestamp).isValid, isFalse);
    expect(eventSchema.validate(badPlatform).isValid, isFalse);
    expect(eventSchema.validate(extraField).isValid, isFalse);
    expect(batchSchema.validate({'events': <Object?>[]}).isValid, isFalse);
  });
}
