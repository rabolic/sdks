import 'package:flutter/foundation.dart';

import 'client.dart';
import 'rabolic.dart';

/// The default ingest host.
const String defaultRabolicHost = 'https://ingest.rabolic.com';

/// Whether the person using the app has agreed to analytics.
enum RabolicConsent {
  /// Track and send normally. This is the default.
  granted,

  /// Keep new events in memory only and send nothing until consent is
  /// granted or denied.
  pending,

  /// Drop every event and clear the queue.
  denied,
}

/// Options for [Rabolic.init] and [RabolicClient].
///
/// Only [projectKey] is required. Leave [flushInterval] and [maxQueueSize]
/// unset to get the platform defaults from the Rabolic protocol: 15 s and
/// 10,000 events on iOS and Android, 5 s and 1,000 events on the web.
@immutable
class RabolicConfig {
  /// Creates the SDK options.
  const RabolicConfig({
    required this.projectKey,
    this.host = defaultRabolicHost,
    this.flushAt = 20,
    this.flushInterval,
    this.maxQueueSize,
    this.trackLifecycle = true,
    this.consent = RabolicConsent.granted,
    this.debug = false,
  });

  /// The project's publishable key (`rb_pub_…`).
  ///
  /// The SDK never logs it.
  final String projectKey;

  /// The ingest host, without a trailing path. Override it for a first-party
  /// proxy or a self-hosted ingest.
  final String host;

  /// Send as soon as this many events are queued.
  final int flushAt;

  /// Send queued events at least this often.
  ///
  /// `null` means 15 s on iOS and Android and 5 s on the web.
  final Duration? flushInterval;

  /// The most events kept on the device. When the queue is full the oldest
  /// event is dropped.
  ///
  /// `null` means 10,000 on iOS and Android and 1,000 on the web. The web
  /// is always capped at 1,000 because the queue lives in `localStorage`.
  final int? maxQueueSize;

  /// Send `$app_first_open`, `$app_update`, `$app_open` and
  /// `$app_background` automatically (iOS and Android).
  final bool trackLifecycle;

  /// The consent state to start with when the app has not called
  /// [Rabolic.setConsent], [Rabolic.optIn] or [Rabolic.optOut] before.
  final RabolicConsent consent;

  /// Log every call and every response to the console.
  final bool debug;
}
