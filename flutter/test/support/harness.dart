import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:fake_async/fake_async.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:rabolic_flutter/rabolic_flutter.dart';
import 'package:rabolic_flutter/src/device_context.dart';
import 'package:rabolic_flutter/src/lifecycle.dart';
import 'package:rabolic_flutter/src/platform.dart';
import 'package:rabolic_flutter/src/services.dart';
import 'package:rabolic_flutter/src/storage/key_value_store.dart';
import 'package:rabolic_flutter/src/storage/queue_store.dart';

const String testKey = 'rb_pub_test_1234567890';

/// A request the fake ingest received, with the body decompressed.
class RecordedRequest {
  RecordedRequest(this.request, this.text);

  final http.BaseRequest request;
  final String text;

  String get path => request.url.path;
  Map<String, String> get headers => request.headers;
  Map<String, Object?> get json => jsonDecode(text) as Map<String, Object?>;
  List<Map<String, Object?>> get events =>
      (json['events']! as List<Object?>).cast<Map<String, Object?>>();
  List<String> get eventNames =>
      events.map((e) => e['event']! as String).toList();
}

/// Lifecycle the test drives by hand.
class FakeLifecycle implements LifecycleSource {
  FakeLifecycle({this.startsInForeground = true});

  final bool startsInForeground;
  void Function()? _onForeground;
  void Function()? _onBackground;

  @override
  bool get isInForeground => startsInForeground;

  @override
  void start({
    required void Function() onForeground,
    required void Function() onBackground,
  }) {
    _onForeground = onForeground;
    _onBackground = onBackground;
  }

  void foreground() => _onForeground!();
  void background() => _onBackground!();

  @override
  void dispose() {}
}

class FakeContextLoader implements ContextLoader {
  FakeContextLoader({this.appVersion = '1.0.0'});

  final String appVersion;

  @override
  Future<Map<String, Object?>> load(RabolicPlatform platform) async =>
      <String, Object?>{
        'platform': platform.wireName,
        'app': <String, Object?>{
          'version': appVersion,
          'build': '42',
          'bundle': 'com.example.app',
        },
        if (platform.isMobile) ...<String, Object?>{
          'device': <String, Object?>{
            'type': 'mobile',
            'model': 'Pixel 9',
            'manufacturer': 'Google',
          },
          'os': <String, Object?>{'name': 'Android', 'version': '15'},
        },
        if (platform == RabolicPlatform.web) 'user_agent': 'Mozilla/5.0 (test)',
        'locale': 'en-US',
        'timezone': 'Europe/Berlin',
        'screen': <String, Object?>{'width': 393, 'height': 852, 'density': 3},
      };
}

/// Random whose doubles are fixed, so backoff delays are predictable.
class FixedRandom implements Random {
  FixedRandom(this.value);

  final double value;
  final Random _ints = Random(1);

  @override
  double nextDouble() => value;

  @override
  int nextInt(int max) => _ints.nextInt(max);

  @override
  bool nextBool() => _ints.nextBool();
}

typedef Responder = FutureOr<http.Response> Function(RecordedRequest request);

http.Response ok([int accepted = 1]) => http.Response(
  jsonEncode(<String, Object?>{
    'accepted': accepted,
    'rejected': <Object?>[],
    'dropped': 0,
  }),
  200,
);

http.Response status(int code, {Map<String, String>? headers}) =>
    http.Response('{"error":"x"}', code, headers: headers ?? const {});

/// One "process" of an app using Rabolic, with fakes for every plugin.
///
/// Storage objects can be passed to a second harness to simulate a
/// restart. The clock is [base] plus [FakeAsync.elapsed] plus anything
/// added with [advanceClock].
class Harness {
  Harness({
    this.async,
    RabolicConfig? config,
    MemoryKeyValueStore? store,
    QueueStore? queueStore,
    this.platform = RabolicPlatform.android,
    Responder? batchResponder,
    Responder? configResponder,
    bool startsInForeground = true,
    String appVersion = '1.0.0',
    Uri? landingUri,
    this.randomValue = 0,
    DateTime? base,
    Duration clockOffset = Duration.zero,
  }) : config = config ?? const RabolicConfig(projectKey: testKey),
       store = store ?? MemoryKeyValueStore(),
       queueStore = queueStore ?? MemoryQueueStore(),
       base = base ?? DateTime.utc(2026, 11, 8, 10),
       _offset = clockOffset,
       lifecycle = FakeLifecycle(startsInForeground: startsInForeground) {
    this.batchResponder = batchResponder ?? (_) => ok();
    this.configResponder = configResponder ?? (_) => http.Response('{}', 200);
    final httpClient = MockClient((request) async {
      final bytes = request.bodyBytes;
      final text = request.headers['Content-Encoding'] == 'gzip'
          ? utf8.decode(gzip.decode(bytes))
          : utf8.decode(bytes);
      final recorded = RecordedRequest(request, text);
      if (request.url.path == '/v1/config') {
        configRequests.add(recorded);
        return this.configResponder(recorded);
      }
      requests.add(recorded);
      return this.batchResponder(recorded);
    });
    client = RabolicClient.withServices(
      this.config,
      RabolicServices(
        platform: platform,
        keyValueStore: this.store,
        queueStore: this.queueStore,
        contextLoader: FakeContextLoader(appVersion: appVersion),
        lifecycle: lifecycle,
        httpClient: httpClient,
        clock: now,
        random: FixedRandom(randomValue),
        logSink: logs.add,
        landingUri: landingUri,
      ),
    );
  }

  final FakeAsync? async;
  final RabolicConfig config;
  final MemoryKeyValueStore store;
  final QueueStore queueStore;
  final RabolicPlatform platform;
  final FakeLifecycle lifecycle;
  final DateTime base;

  /// `Random.nextDouble()` for backoff jitter: 0 gives the shortest
  /// delays (half the base).
  final double randomValue;
  Duration _offset;
  late Responder batchResponder;
  late Responder configResponder;
  late final RabolicClient client;

  final List<RecordedRequest> requests = <RecordedRequest>[];
  final List<RecordedRequest> configRequests = <RecordedRequest>[];
  final List<String> logs = <String>[];

  DateTime now() => base.add(_offset).add(async?.elapsed ?? Duration.zero);

  /// Moves the clock without firing timers (time the app spends suspended).
  void advanceClock(Duration duration) => _offset += duration;

  List<Map<String, Object?>> get queued => client.debugQueuedEvents;
  List<String> get queuedNames =>
      queued.map((e) => e['event']! as String).toList();

  /// Every event created so far, in order: sent ones, then queued ones.
  List<Map<String, Object?>> get events => [...sentEvents, ...queued];
  List<String> get names => events.map((e) => e['event']! as String).toList();

  List<Map<String, Object?>> get sentEvents => <Map<String, Object?>>[
    for (final r in requests) ...r.events,
  ];
  List<String> get sentNames =>
      sentEvents.map((e) => e['event']! as String).toList();
}

/// Runs [body] in fake time with the microtasks flushed after it.
void runFake(void Function(FakeAsync async) body) {
  fakeAsync((async) {
    body(async);
    async.flushMicrotasks();
  });
}

/// Starts a harness in fake time and waits for it to be ready.
Harness startHarness(
  FakeAsync async, {
  RabolicConfig? config,
  MemoryKeyValueStore? store,
  QueueStore? queueStore,
  RabolicPlatform platform = RabolicPlatform.android,
  Responder? batchResponder,
  Responder? configResponder,
  bool startsInForeground = true,
  String appVersion = '1.0.0',
  Uri? landingUri,
  double randomValue = 0,
  Duration clockOffset = Duration.zero,
}) {
  final harness = Harness(
    async: async,
    config: config,
    store: store,
    queueStore: queueStore,
    platform: platform,
    batchResponder: batchResponder,
    configResponder: configResponder,
    startsInForeground: startsInForeground,
    appVersion: appVersion,
    landingUri: landingUri,
    randomValue: randomValue,
    clockOffset: clockOffset,
  );
  async.flushMicrotasks();
  return harness;
}

/// A config that never flushes on its own, so tests decide when to send.
RabolicConfig manualFlushConfig({
  bool trackLifecycle = false,
  RabolicConsent consent = RabolicConsent.granted,
  int? maxQueueSize,
  bool debug = false,
}) => RabolicConfig(
  projectKey: testKey,
  host: 'https://ingest.test',
  flushAt: 1000,
  flushInterval: const Duration(days: 1),
  trackLifecycle: trackLifecycle,
  consent: consent,
  maxQueueSize: maxQueueSize,
  debug: debug,
);
