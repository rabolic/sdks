import 'package:flutter/widgets.dart';

/// Tells the client when the app moves between foreground and background.
abstract interface class LifecycleSource {
  /// Whether the app is in the foreground right now.
  bool get isInForeground;

  /// Starts reporting changes.
  void start({
    required void Function() onForeground,
    required void Function() onBackground,
  });

  /// Stops reporting changes.
  void dispose();
}

/// [LifecycleSource] backed by [AppLifecycleListener].
///
/// "Background" is the `hidden` state: on iOS and Android the app is no
/// longer visible; on the web the tab is hidden. Brief `inactive` moments
/// (a phone call banner, Control Center) don't count.
class FlutterLifecycleSource implements LifecycleSource {
  AppLifecycleListener? _listener;

  @override
  bool get isInForeground => switch (WidgetsBinding.instance.lifecycleState) {
    null || AppLifecycleState.resumed || AppLifecycleState.inactive => true,
    _ => false,
  };

  @override
  void start({
    required void Function() onForeground,
    required void Function() onBackground,
  }) {
    _listener?.dispose();
    _listener = AppLifecycleListener(
      onShow: onForeground,
      onHide: onBackground,
    );
  }

  @override
  void dispose() {
    _listener?.dispose();
    _listener = null;
  }
}
