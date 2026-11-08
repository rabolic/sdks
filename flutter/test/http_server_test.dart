// Runs the client against a real dart:io HttpServer that implements the
// ingest protocol's responses, with a real http.Client and a real queue file.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:json_schema/json_schema.dart';
import 'package:rabolic_flutter/rabolic_flutter.dart';
import 'package:rabolic_flutter/src/platform.dart';
import 'package:rabolic_flutter/src/services.dart';
import 'package:rabolic_flutter/src/storage/file_queue_store.dart';
import 'package:rabolic_flutter/src/storage/key_value_store.dart';

import 'support/harness.dart';

/// A minimal ingest service. [script] picks the response for the n-th
/// batch request (1-based); `null` means "accept".
class FakeIngest {
  FakeIngest(this.script);

  final ({int status, Map<String, String> headers})? Function(
    int n,
    List<Map<String, Object?>> events,
  )
  script;
  late final HttpServer _server;
  late final JsonSchema _schema;
  final List<Map<String, Object?>> accepted = [];
  final List<int> statuses = [];
  final List<String> problems = [];
  int batchRequests = 0;
  int configRequests = 0;

  String get host => 'http://${_server.address.host}:${_server.port}';

  Future<void> start() async {
    _schema = JsonSchema.create(
      jsonDecode(
            File('../spec/schema/batch.schema.json').readAsStringSync(),
          )
          as Object,
      schemaVersion: SchemaVersion.draft2020_12,
    );
    _server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _server.listen(_handle);
  }

  Future<void> close() => _server.close(force: true);

  Future<void> _handle(HttpRequest request) async {
    final bytes = await request.fold<List<int>>([], (all, b) => all..addAll(b));
    final response = request.response;
    if (request.uri.path == '/v1/config') {
      configRequests++;
      if (request.uri.queryParameters['key'] != testKey) {
        return _send(response, 401, {'error': 'invalid_key'});
      }
      return _send(response, 200, {'enabled': true, 'sampleRate': 1});
    }
    if (request.method != 'POST' || request.uri.path != '/v1/batch') {
      return _send(response, 404, {'error': 'not_found'});
    }
    if (request.headers.value('authorization') != 'Bearer $testKey') {
      return _send(response, 401, {'error': 'invalid_key'});
    }
    final gzipped = request.headers.value('content-encoding') == 'gzip';
    final body =
        jsonDecode(utf8.decode(gzipped ? gzip.decode(bytes) : bytes))
            as Map<String, Object?>;
    final result = _schema.validate(body);
    if (!result.isValid) {
      problems.add(result.errors.join('; '));
      return _send(response, 400, {'error': 'invalid_batch'});
    }
    final events = (body['events']! as List).cast<Map<String, Object?>>();
    final n = ++batchRequests;
    final scripted = script(n, events);
    if (scripted != null) {
      scripted.headers.forEach(response.headers.set);
      return _send(response, scripted.status, {'error': 'scripted'});
    }
    accepted.addAll(events);
    return _send(response, 200, {
      'accepted': events.length,
      'rejected': <Object?>[],
      'dropped': 0,
    });
  }

  Future<void> _send(HttpResponse response, int status, Object body) async {
    statuses.add(status);
    response
      ..statusCode = status
      ..headers.contentType = ContentType.json
      ..write(jsonEncode(body));
    await response.close();
  }
}

RabolicClient clientFor(
  FakeIngest ingest,
  Directory dir, {
  MemoryKeyValueStore? store,
  String key = testKey,
}) {
  return RabolicClient.withServices(
    RabolicConfig(
      projectKey: key,
      host: ingest.host,
      flushAt: 1000,
      flushInterval: const Duration(minutes: 10),
      trackLifecycle: false,
    ),
    RabolicServices(
      platform: RabolicPlatform.ios,
      keyValueStore: store ?? MemoryKeyValueStore(),
      queueStore: FileQueueStore(() async => dir),
      contextLoader: FakeContextLoader(),
      lifecycle: FakeLifecycle(),
      httpClient: http.Client(),
      ownsHttpClient: true,
      random: FixedRandom(0),
    ),
  );
}

Future<void> waitFor(
  bool Function() condition, {
  Duration timeout = const Duration(seconds: 15),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) fail('timed out');
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
}

void main() {
  late Directory dir;
  setUp(() => dir = Directory.systemTemp.createTempSync('rabolic_it'));
  tearDown(() => dir.deleteSync(recursive: true));

  test(
    'delivers every event once, in order, through 500, 429 and 413',
    () async {
      final ingest = FakeIngest(
        (n, events) => switch (n) {
          1 => (status: 500, headers: {}),
          2 => (status: 429, headers: {'retry-after': '1'}),
          _ when events.length > 4 => (status: 413, headers: {}),
          _ => null,
        },
      );
      await ingest.start();
      final client = clientFor(ingest, dir);
      await client.ready;
      for (var i = 0; i < 10; i++) {
        client.track('event_$i', properties: {'i': i, 'pad': 'p' * 200});
      }
      unawaited(client.flush());
      await waitFor(() => ingest.accepted.length == 10);

      expect(ingest.problems, isEmpty);
      expect(ingest.statuses, containsAllInOrder([500, 429, 413]));
      expect(ingest.accepted.map((e) => e['event']), [
        for (var i = 0; i < 10; i++) 'event_$i',
      ]);
      expect(ingest.accepted.map((e) => e['event_id']).toSet(), hasLength(10));
      expect(ingest.configRequests, 1);

      await client.close();
      expect(await FileQueueStore(() async => dir).load(), isEmpty);
      await ingest.close();
    },
  );

  test(
    '401 stops sending and keeps the queue on disk for the next launch',
    () async {
      final ingest = FakeIngest((n, events) => null);
      await ingest.start();
      final store = MemoryKeyValueStore();

      final rejected = clientFor(
        ingest,
        dir,
        store: store,
        key: 'rb_pub_wrong_key',
      );
      await rejected.ready;
      rejected.track('kept');
      await rejected.flush();
      await rejected.flush();
      await rejected.close();
      expect(ingest.accepted, isEmpty);
      expect(await FileQueueStore(() async => dir).load(), hasLength(1));

      final fixed = clientFor(ingest, dir, store: store);
      await fixed.ready;
      await waitFor(() => ingest.accepted.isNotEmpty);
      expect(ingest.accepted.single['event'], 'kept');
      await fixed.close();
      await ingest.close();
    },
  );
}
