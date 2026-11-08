import 'dart:convert';

import 'package:flutter/foundation.dart';

/// Settings served by `GET /v1/config` (protocol §6), with the protocol's
/// defaults for anything missing or malformed.
@immutable
class RemoteConfig {
  /// Creates a config. The defaults are the protocol's.
  const RemoteConfig({
    this.enabled = true,
    this.sessionTimeoutWebMin = 30,
    this.sessionBackgroundSec = 30,
    this.lifecycle = true,
    this.blockedEvents = const <String>{},
    this.sampleRate = 1,
  });

  /// Reads a config document, ignoring fields of the wrong type.
  factory RemoteConfig.fromJson(Map<String, Object?> json) {
    const defaults = RemoteConfig();
    final autocapture = json['autocapture'];
    final blocked = json['blockedEvents'];
    return RemoteConfig(
      enabled: _bool(json['enabled']) ?? defaults.enabled,
      sessionTimeoutWebMin:
          _positive(json['sessionTimeoutWebMin']) ??
          defaults.sessionTimeoutWebMin,
      sessionBackgroundSec:
          _positive(json['sessionBackgroundSec']) ??
          defaults.sessionBackgroundSec,
      lifecycle: autocapture is Map<String, Object?>
          ? _bool(autocapture['lifecycle']) ?? defaults.lifecycle
          : defaults.lifecycle,
      blockedEvents: blocked is List<Object?>
          ? blocked.whereType<String>().toSet()
          : defaults.blockedEvents,
      sampleRate: switch (json['sampleRate']) {
        final num rate => rate.clamp(0, 1).toDouble(),
        _ => defaults.sampleRate,
      },
    );
  }

  /// Reads a cached config document, or returns `null` when it is damaged.
  static RemoteConfig? tryDecode(String? text) {
    if (text == null) return null;
    try {
      final decoded = jsonDecode(text);
      return decoded is Map<String, Object?>
          ? RemoteConfig.fromJson(decoded)
          : null;
    } on FormatException {
      return null;
    }
  }

  /// `false` stops sending and clears the queue.
  final bool enabled;

  /// Web inactivity, in minutes, after which a new session starts.
  final int sessionTimeoutWebMin;

  /// Background time, in seconds, after which returning to the app starts a
  /// new session.
  final int sessionBackgroundSec;

  /// `autocapture.lifecycle`: whether `$app_*` events are sent.
  final bool lifecycle;

  /// Event names the project blocks. They are dropped before queueing.
  final Set<String> blockedEvents;

  /// The share of devices that send events, from 0 to 1.
  final double sampleRate;

  /// Whether the device with [anonymousId] is in the sample.
  ///
  /// The decision is stable per device: it depends only on the id.
  bool keepsDevice(String anonymousId) {
    if (sampleRate >= 1) return true;
    return fnv1a32(anonymousId) / 4294967296 < sampleRate;
  }

  static bool? _bool(Object? value) => value is bool ? value : null;

  static int? _positive(Object? value) =>
      value is num && value > 0 ? value.round() : null;
}

/// The 32-bit FNV-1a hash of [value]'s UTF-8 bytes.
///
/// Written with arithmetic that stays below 2^53, so it gives the same
/// result on the web, where integers are doubles.
int fnv1a32(String value) {
  const prime = 16777619; // 2^24 + 403
  const modulus = 4294967296; // 2^32
  var hash = 2166136261;
  for (final byte in utf8.encode(value)) {
    hash ^= byte;
    // hash * prime mod 2^32, split as hash * 403 + hash * 2^24 so no
    // intermediate exceeds 2^53. Only hash's low byte survives the 2^24
    // shift modulo 2^32.
    hash = (hash * (prime - 16777216) + (hash % 256) * 16777216) % modulus;
  }
  return hash;
}
