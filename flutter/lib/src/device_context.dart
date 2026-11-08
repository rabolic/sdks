import 'dart:ui';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:package_info_plus/package_info_plus.dart';

import 'platform.dart';
import 'timezone.dart';
import 'validation.dart';

/// Builds the parts of `context` that don't change while the app runs.
///
/// An interface so the core logic can be tested without platform plugins.
abstract interface class ContextLoader {
  /// The context for [platform]. Never throws; a failing source is left out.
  Future<Map<String, Object?>> load(RabolicPlatform platform);
}

/// [ContextLoader] backed by `package_info_plus`, `device_info_plus` and the
/// engine's view and locale information.
///
/// It reads model, manufacturer and OS only: no advertising ids, no
/// Android id, nothing that fingerprints a device.
class PluginContextLoader implements ContextLoader {
  /// Creates the loader.
  PluginContextLoader({DeviceInfoPlugin? deviceInfo})
    : _deviceInfo = deviceInfo ?? DeviceInfoPlugin();

  final DeviceInfoPlugin _deviceInfo;

  @override
  Future<Map<String, Object?>> load(RabolicPlatform platform) async {
    final screen = _screen();
    final context = <String, Object?>{'platform': platform.wireName};

    final app = await _app();
    if (app.isNotEmpty) context['app'] = app;

    try {
      switch (platform) {
        case RabolicPlatform.ios:
          _addIos(context, await _deviceInfo.iosInfo);
        case RabolicPlatform.android:
          _addAndroid(context, await _deviceInfo.androidInfo, screen);
        case RabolicPlatform.web:
          final agent = (await _deviceInfo.webBrowserInfo).userAgent;
          if (agent != null) context['user_agent'] = truncate(agent, 1024);
        case RabolicPlatform.unsupported:
          break;
      }
    } on Object {
      // Device details are best effort.
    }

    final locale = PlatformDispatcher.instance.locale.toLanguageTag();
    if (locale != 'und') context['locale'] = truncate(locale, 35);
    final timeZone = ianaTimeZone();
    if (timeZone != null) context['timezone'] = truncate(timeZone, 64);
    if (screen != null) context['screen'] = screen;
    return context;
  }

  Future<Map<String, String>> _app() async {
    try {
      final info = await PackageInfo.fromPlatform();
      return _nonEmpty(<String, String>{
        'version': info.version,
        'build': info.buildNumber,
        'bundle': info.packageName,
      });
    } on Object {
      return const <String, String>{};
    }
  }

  void _addIos(Map<String, Object?> context, IosDeviceInfo info) {
    context['device'] = _nonEmpty(<String, String>{
      'type': info.model.toLowerCase().contains('ipad') ? 'tablet' : 'mobile',
      'model': info.utsname.machine,
      'manufacturer': 'Apple',
    });
    context['os'] = _nonEmpty(<String, String>{
      'name': info.systemName,
      'version': info.systemVersion,
    });
  }

  void _addAndroid(
    Map<String, Object?> context,
    AndroidDeviceInfo info,
    Map<String, num>? screen,
  ) {
    final features = info.systemFeatures;
    final isTv =
        features.contains('android.software.leanback') ||
        features.contains('android.hardware.type.television');
    final shortestSide = screen == null
        ? null
        : (screen['width']! < screen['height']!
              ? screen['width']!
              : screen['height']!);
    // 600 dp is Android's own threshold for tablet layouts.
    final isTablet = shortestSide != null && shortestSide >= 600;
    context['device'] = _nonEmpty(<String, String>{
      'type': isTv ? 'tv' : (isTablet ? 'tablet' : 'mobile'),
      'model': info.model,
      'manufacturer': info.manufacturer,
    });
    context['os'] = _nonEmpty(<String, String>{
      'name': 'Android',
      'version': info.version.release,
    });
  }

  /// Logical screen size and pixel density of the app's main view.
  Map<String, num>? _screen() {
    final view = PlatformDispatcher.instance.implicitView;
    if (view == null || view.devicePixelRatio == 0) return null;
    final size = view.physicalSize / view.devicePixelRatio;
    if (size.isEmpty) return null;
    return <String, num>{
      'width': size.width.round(),
      'height': size.height.round(),
      'density': view.devicePixelRatio,
    };
  }

  static Map<String, String> _nonEmpty(Map<String, String> values) => {
    for (final MapEntry(:key, :value) in values.entries)
      if (value.isNotEmpty) key: truncate(value, Limits.shortText),
  };
}
