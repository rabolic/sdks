import 'package:flutter/widgets.dart';

import 'client.dart';
import 'rabolic.dart';

/// Returns the screen name for a route, or `null` to skip it.
typedef ScreenNameExtractor = String? Function(RouteSettings settings);

/// Returns whether a route should be tracked as a screen.
typedef RouteFilter = bool Function(Route<dynamic>? route);

/// Sends `$screen` when the visible page changes.
///
/// Add it to `MaterialApp.navigatorObservers`, to go_router's
/// `GoRouter(observers: [...])`, or to auto_route's
/// `config(navigatorObservers: () => [...])`. The screen name is the
/// route's `settings.name`: the `name:` of a `MaterialPageRoute`'s
/// `RouteSettings`, a GoRoute's `name` or path, or an auto_route route name.
///
/// By default only [PageRoute]s count, so dialogs, bottom sheets and menus
/// aren't screens, and closing one doesn't re-send the page beneath.
class RabolicNavigatorObserver extends NavigatorObserver {
  /// Creates an observer.
  ///
  /// [nameExtractor] maps a route's settings to a screen name (return
  /// `null` to skip). [routeFilter] decides which routes count as screens.
  /// [client] defaults to the `Rabolic` facade's client.
  RabolicNavigatorObserver({
    this.nameExtractor = defaultNameExtractor,
    this.routeFilter = defaultRouteFilter,
    RabolicClient? client,
  }) : _client = client;

  /// Uses `settings.name`.
  static String? defaultNameExtractor(RouteSettings settings) => settings.name;

  /// Accepts [PageRoute]s only.
  static bool defaultRouteFilter(Route<dynamic>? route) => route is PageRoute;

  /// Maps a route's settings to a screen name.
  final ScreenNameExtractor nameExtractor;

  /// Decides which routes are screens.
  final RouteFilter routeFilter;

  final RabolicClient? _client;

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    super.didPush(route, previousRoute);
    if (routeFilter(route)) _send(route);
  }

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
    super.didReplace(newRoute: newRoute, oldRoute: oldRoute);
    if (newRoute != null && routeFilter(newRoute)) _send(newRoute);
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    super.didPop(route, previousRoute);
    // Only leaving a screen reveals one; closing a dialog doesn't.
    if (previousRoute != null &&
        routeFilter(route) &&
        routeFilter(previousRoute)) {
      _send(previousRoute);
    }
  }

  void _send(Route<dynamic> route) {
    try {
      final name = nameExtractor(route.settings);
      if (name == null || name.trim().isEmpty) return;
      final client = _client ?? Rabolic.instance;
      client?.screen(name);
    } on Object {
      // A throwing extractor must not break navigation.
    }
  }
}
