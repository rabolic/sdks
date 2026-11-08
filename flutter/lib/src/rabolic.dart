import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'client.dart';
import 'config.dart';

/// The Rabolic SDK, as static calls.
///
/// ```dart
/// await Rabolic.init(const RabolicConfig(projectKey: 'rb_pub_…'));
/// Rabolic.track('workout_started', properties: {'program': 'strength-30'});
/// ```
///
/// Every method is safe to call at any time: before [init] they do nothing,
/// and they never throw. For dependency injection in tests, use a
/// [RabolicClient] instead.
abstract final class Rabolic {
  static RabolicClient? _client;
  static bool _warnedNotInitialized = false;

  /// The client behind the static calls, or `null` before [init].
  static RabolicClient? get instance => _client;

  /// Starts the SDK. Call it once, early in `main`.
  ///
  /// Calls made right after `init` without awaiting it are kept and sent
  /// once the SDK has loaded. A second `init` is ignored.
  static Future<void> init(RabolicConfig config, {http.Client? httpClient}) {
    final existing = _client;
    if (existing != null) {
      if (kDebugMode) debugPrint('[Rabolic] init() called twice; ignored.');
      return existing.ready;
    }
    final client = RabolicClient(config, httpClient: httpClient);
    _client = client;
    return client.ready;
  }

  /// Replaces the client behind the static calls. For tests.
  @visibleForTesting
  static set instance(RabolicClient? client) => _client = client;

  /// Stops the SDK and forgets the client, so [init] can run again.
  static Future<void> close() async {
    final client = _client;
    _client = null;
    await client?.close();
  }

  static RabolicClient? get _active {
    final client = _client;
    if (client == null && kDebugMode && !_warnedNotInitialized) {
      _warnedNotInitialized = true;
      debugPrint('[Rabolic] called before Rabolic.init(); ignored.');
    }
    return client;
  }

  /// The anonymous id of this install, or `null` until [init] completes.
  static String? get anonymousId => _client?.anonymousId;

  /// A stable UUID for the identified person, for `in_app_purchase`'s
  /// `applicationUserName`. See [RabolicClient.appAccountToken].
  static String? get appAccountToken => _client?.appAccountToken;

  /// Sends a custom event. See [RabolicClient.track].
  static void track(String name, {Map<String, Object?>? properties}) =>
      _active?.track(name, properties: properties);

  /// Sends a `$screen` event. See [RabolicClient.screen].
  static void screen(String name, {Map<String, Object?>? properties}) =>
      _active?.screen(name, properties: properties);

  /// Identifies the person. See [RabolicClient.identify].
  static void identify(String userId, {Map<String, Object?>? traits}) =>
      _active?.identify(userId, traits: traits);

  /// Forgets the person, for logout. See [RabolicClient.reset].
  static void reset() => _active?.reset();

  /// Adds super properties. See [RabolicClient.register].
  static void register(Map<String, Object?> properties) =>
      _active?.register(properties);

  /// Removes a super property. See [RabolicClient.unregister].
  static void unregister(String key) => _active?.unregister(key);

  /// Changes the consent state. See [RabolicClient.setConsent].
  static void setConsent(RabolicConsent consent) =>
      _active?.setConsent(consent);

  /// Stops tracking and clears the queue: `setConsent(denied)`.
  static void optOut() => _active?.optOut();

  /// Resumes tracking: `setConsent(granted)`.
  static void optIn() => _active?.optIn();

  /// Sends queued events now. See [RabolicClient.flush].
  static Future<void> flush() async => _active?.flush();

  /// Sends `$deep_link` for an incoming link. See
  /// [RabolicClient.handleDeepLink].
  static void handleDeepLink(Uri uri) => _active?.handleDeepLink(uri);
}
