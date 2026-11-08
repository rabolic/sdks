import 'package:flutter/foundation.dart';

/// The platforms Rabolic's data model knows.
enum RabolicPlatform {
  /// iOS and iPadOS.
  ios,

  /// Android.
  android,

  /// Flutter web.
  web,

  /// Desktop and anything else. The SDK is a no-op there.
  unsupported;

  /// The value for `context.platform`.
  String get wireName => name;

  /// Whether the mobile session and lifecycle rules apply.
  bool get isMobile => this == ios || this == android;
}

/// The platform this app runs on.
RabolicPlatform detectPlatform() {
  if (kIsWeb) return RabolicPlatform.web;
  return switch (defaultTargetPlatform) {
    TargetPlatform.iOS => RabolicPlatform.ios,
    TargetPlatform.android => RabolicPlatform.android,
    _ => RabolicPlatform.unsupported,
  };
}
