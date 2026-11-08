import 'dart:math';

import 'package:flutter/widgets.dart';
import 'package:http/http.dart' as http;

import 'clock.dart';
import 'device_context.dart';
import 'ids.dart';
import 'lifecycle.dart';
import 'logger.dart';
import 'platform.dart';
import 'storage/default_queue_store.dart';
import 'storage/key_value_store.dart';
import 'storage/queue_store.dart';

/// Everything `RabolicClient` needs from the outside world.
///
/// Production code uses [RabolicServices.platformDefaults]; tests pass
/// fakes for storage, lifecycle, time, randomness and HTTP.
class RabolicServices {
  /// Creates a set of services.
  RabolicServices({
    required this.platform,
    required this.keyValueStore,
    required this.queueStore,
    required this.contextLoader,
    required this.lifecycle,
    required this.httpClient,
    this.ownsHttpClient = false,
    this.clock = systemClock,
    Random? random,
    IdGenerator? ids,
    this.logSink,
    this.landingUri,
  }) : random = random ?? Random(),
       ids = ids ?? IdGenerator();

  /// The real plugins for the current platform.
  ///
  /// On desktop no plugin is touched: the client is a no-op there.
  factory RabolicServices.platformDefaults({http.Client? httpClient}) {
    final platform = detectPlatform();
    final supported = platform != RabolicPlatform.unsupported;
    if (supported) WidgetsFlutterBinding.ensureInitialized();
    final keyValueStore = supported
        ? FallbackKeyValueStore(SharedPreferencesStore())
        : MemoryKeyValueStore();
    return RabolicServices(
      platform: platform,
      keyValueStore: keyValueStore,
      queueStore: supported
          ? createDefaultQueueStore(keyValueStore)
          : MemoryQueueStore(),
      contextLoader: PluginContextLoader(),
      lifecycle: FlutterLifecycleSource(),
      httpClient: httpClient ?? http.Client(),
      ownsHttpClient: httpClient == null,
      landingUri: platform == RabolicPlatform.web ? Uri.base : null,
    );
  }

  /// The platform the app runs on.
  final RabolicPlatform platform;

  /// Ids, flags and cached config.
  final KeyValueStore keyValueStore;

  /// The persisted event queue.
  final QueueStore queueStore;

  /// Device and app details for `context`.
  final ContextLoader contextLoader;

  /// Foreground and background changes.
  final LifecycleSource lifecycle;

  /// The HTTP client for ingest requests.
  final http.Client httpClient;

  /// Whether the client should close [httpClient] when it is closed.
  final bool ownsHttpClient;

  /// The current time.
  final Clock clock;

  /// Jitter for retry backoff.
  final Random random;

  /// Event, session and anonymous ids. Uses [Random.secure].
  final IdGenerator ids;

  /// Where log lines go; `debugPrint` when `null`.
  final LogSink? logSink;

  /// The page URL a web app was opened with, for the campaign session rule.
  final Uri? landingUri;
}
