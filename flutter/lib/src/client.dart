import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'clock.dart';
import 'config.dart';
import 'deep_link.dart';
import 'identity.dart';
import 'logger.dart';
import 'platform.dart';
import 'queue.dart';
import 'remote_config.dart';
import 'services.dart';
import 'session.dart';
import 'transport.dart';
import 'uploader.dart';
import 'validation.dart';

/// A Rabolic SDK instance.
///
/// Most apps use the static `Rabolic` facade, which holds one of these.
/// Create a client directly to inject an `http.Client`, to hold more than
/// one, or to pass one to code under test.
///
/// The client starts itself when constructed. Calls made before it is
/// [ready] are kept, with their original timestamps, and applied in order
/// once it is. No method throws into the app: problems are logged with
/// `debug: true` and the call is ignored.
class RabolicClient {
  /// Creates and starts a client with the real platform plugins.
  RabolicClient(RabolicConfig config, {http.Client? httpClient})
    : this.withServices(
        config,
        RabolicServices.platformDefaults(httpClient: httpClient),
      );

  /// Creates and starts a client with the given [services]. For tests.
  @visibleForTesting
  RabolicClient.withServices(this.config, RabolicServices services)
    : _services = services,
      _logger = RabolicLogger(
        verbose: config.debug,
        projectKey: config.projectKey,
        sink: services.logSink,
      ) {
    _launchTime = services.clock();
    final isWeb = services.platform == RabolicPlatform.web;
    _queue = EventQueue(
      store: services.queueStore,
      // localStorage holds about 5 MB, so the web is capped at 1,000.
      maxSize: isWeb
          ? (config.maxQueueSize ?? 1000).clamp(1, 1000)
          : config.maxQueueSize ?? 10000,
      clock: services.clock,
      logger: _logger,
    );
    _transport = Transport(
      client: services.httpClient,
      host: config.host,
      projectKey: config.projectKey,
      platform: services.platform,
      clock: services.clock,
    );
    _uploader = Uploader(
      queue: _queue,
      transport: _transport,
      logger: _logger,
      random: services.random,
      canSend: () => _canSend,
    );
    _identity = Identity(store: services.keyValueStore, ids: services.ids);
    _session = SessionTracker(ids: services.ids, store: services.keyValueStore);
    ready = _start();
  }

  static const String _consentKey = 'rb_consent';
  static const String _configKey = 'rb_remote_config';
  static const String _installedKey = 'rb_installed';
  static const String _appVersionKey = 'rb_app_version';

  /// Remote config is refetched on foreground once it is this old.
  static const Duration remoteConfigMaxAge = Duration(minutes: 5);

  /// The options this client was created with.
  final RabolicConfig config;

  /// Completes when the client has loaded its state. Never completes with
  /// an error.
  late final Future<void> ready;

  final RabolicServices _services;
  final RabolicLogger _logger;
  late final EventQueue _queue;
  late final Transport _transport;
  late final Uploader _uploader;
  late final Identity _identity;
  late final SessionTracker _session;
  late final DateTime _launchTime;

  final List<void Function()> _beforeReady = <void Function()>[];
  // Events created while consent is pending: memory only, never on disk.
  final List<QueuedEvent> _pendingConsent = <QueuedEvent>[];

  bool _isReady = false;
  bool _inert = false;
  bool _closed = false;
  RabolicConsent _consent = RabolicConsent.granted;
  RemoteConfig _remoteConfig = const RemoteConfig();
  bool _sampledIn = true;
  Map<String, Object?> _context = const <String, Object?>{};
  Timer? _flushTimer;
  Future<void>? _configFetch;
  DateTime? _configFetchedAt;

  bool _inForeground = true;
  bool _launchOpenPending = false;
  DateTime? _foregroundSince;
  DateTime? _backgroundSince;

  RabolicPlatform get _platform => _services.platform;

  /// The current anonymous id, or `null` until the client is [ready] (and
  /// always on unsupported platforms).
  String? get anonymousId => _isReady ? _identity.anonymousId : null;

  /// The current user id, or `null` when no one is identified.
  String? get userId => _isReady ? _identity.userId : null;

  /// A stable UUID for the identified person, for in-app purchases.
  ///
  /// Pass it as `applicationUserName` in `in_app_purchase`'s
  /// `PurchaseParam`; it becomes StoreKit's `appAccountToken` and Play's
  /// `obfuscatedAccountId`, which lets Rabolic link store transactions to the
  /// person. It is created by [identify], kept across launches, replaced
  /// when a different user is identified and cleared by [reset]. `null`
  /// until someone is identified.
  String? get appAccountToken => _isReady ? _identity.appAccountToken : null;

  /// The current consent state.
  RabolicConsent get consent => _consent;

  /// The queued events, decoded and oldest first, followed by those held in
  /// memory while consent is pending. For tests.
  @visibleForTesting
  List<Map<String, Object?>> get debugQueuedEvents => <Map<String, Object?>>[
    for (final event in <QueuedEvent>[..._queue.events, ..._pendingConsent])
      jsonDecode(event.json) as Map<String, Object?>,
  ];

  /// Sends a custom event.
  ///
  /// [name] is 1 to 200 characters, without control characters, and may not
  /// start with `$`. Use `snake_case`. [properties] hold JSON values.
  void track(String name, {Map<String, Object?>? properties}) {
    _call('track("$name")', (now) {
      final problem = eventNameProblem(name);
      if (problem != null) {
        _logger.error('track("$name") ignored: the name $problem');
        return;
      }
      _enqueue(now, type: 'track', name: name, properties: properties);
    });
  }

  /// Sends a `$screen` event for the screen called [name].
  void screen(String name, {Map<String, Object?>? properties}) {
    _call('screen("$name")', (now) {
      if (name.trim().isEmpty) {
        _logger.error('screen() ignored: the name is empty');
        return;
      }
      final screenName = truncate(name, Limits.screenName);
      _enqueue(
        now,
        type: 'screen',
        name: r'$screen',
        properties: <String, Object?>{...?properties, 'name': screenName},
        context: <String, Object?>{'screen_name': screenName},
      );
    });
  }

  /// Sets the user id on this and every later event, and sends
  /// `$identify` with [traits] (person properties).
  ///
  /// The `$identify` traits also carry `app_account_token`, so Rabolic can
  /// link App Store and Play purchases made with [appAccountToken].
  void identify(String userId, {Map<String, Object?>? traits}) {
    _call('identify', (now) {
      if (userId.isEmpty || userId.runes.length > Limits.userId) {
        _logger.error(
          'identify() ignored: the user id must be 1 to '
          '${Limits.userId} characters',
        );
        return;
      }
      _identity.identify(userId);
      _enqueue(
        now,
        type: 'identify',
        name: r'$identify',
        traits: <String, Object?>{
          ...?traits,
          'app_account_token': _identity.appAccountToken,
        },
      );
    });
  }

  /// Forgets the current person, for logout: a new anonymous id, no user
  /// id, no super properties and a new session.
  void reset() {
    _call('reset', (now) {
      _identity.reset();
      _sampledIn = _remoteConfig.keepsDevice(_identity.anonymousId);
      _session.start(now);
      if (_platform == RabolicPlatform.web) {
        _session.touchWeb(now, _webSessionTimeout);
      }
    });
  }

  /// Adds [properties] to every later event. They are kept across launches
  /// until [unregister] or [reset]. Event properties win over them.
  void register(Map<String, Object?> properties) {
    _call('register', (_) {
      _identity.register(sanitizeProperties(properties, _logger.debug));
    });
  }

  /// Removes the super property [key] added by [register].
  void unregister(String key) {
    _call('unregister("$key")', (_) => _identity.unregister(key));
  }

  /// Changes the consent state. The choice is stored and wins over
  /// [RabolicConfig.consent] on later launches.
  ///
  /// - [RabolicConsent.granted] sends events kept while pending.
  /// - [RabolicConsent.pending] keeps new events in memory and sends nothing.
  /// - [RabolicConsent.denied] drops pending and queued events.
  void setConsent(RabolicConsent consent) {
    _call('setConsent(${consent.name})', (_) {
      unawaited(
        _quietly(_services.keyValueStore.setString(_consentKey, consent.name)),
      );
      _applyConsent(consent);
    });
  }

  /// Same as `setConsent(RabolicConsent.denied)`.
  void optOut() => setConsent(RabolicConsent.denied);

  /// Same as `setConsent(RabolicConsent.granted)`.
  void optIn() => setConsent(RabolicConsent.granted);

  /// Sends `$deep_link` for an incoming link.
  ///
  /// A `rb_aid` parameter (added by the web SDK's `appLink`) becomes
  /// `linked_anonymous_id`, which links the web visitor to this app user.
  /// utm and click-id parameters become `context.campaign`. The full URL is
  /// sent as the `url` property, so strip secrets (login tokens) first.
  void handleDeepLink(Uri uri) {
    _call('handleDeepLink', (now) {
      final linked = linkedAnonymousId(uri);
      final campaign = campaignFromUri(uri);
      _enqueue(
        now,
        type: 'track',
        name: r'$deep_link',
        properties: <String, Object?>{
          'url': truncate(uri.toString(), Limits.url),
          'linked_anonymous_id': ?linked,
        },
        context: campaign.isEmpty
            ? null
            : <String, Object?>{'campaign': campaign},
      );
    });
  }

  /// Sends everything queued now. Completes when the queue is empty, or a
  /// retry has been scheduled after a failure.
  Future<void> flush() async {
    try {
      await ready;
      if (_inert) return;
      await _uploader.flush();
    } on Object catch (error) {
      _logger.debug('flush failed: $error');
    }
  }

  /// Stops timers and lifecycle tracking and writes the queue to storage.
  /// The client ignores calls afterwards.
  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    await ready;
    _flushTimer?.cancel();
    _uploader.dispose();
    _services.lifecycle.dispose();
    await _queue.persisted();
    if (_services.ownsHttpClient) _services.httpClient.close();
  }

  // ---------------------------------------------------------------------
  // Start-up

  Future<void> _start() async {
    if (_platform == RabolicPlatform.unsupported) {
      _inert = true;
      _logger.errorOnce(
        'unsupported',
        'desktop platforms are not supported '
            'yet; Rabolic calls do nothing on this platform.',
      );
      return;
    }
    try {
      final store = _services.keyValueStore;
      await _identity.load();
      _consent =
          _parseConsent(await store.getString(_consentKey)) ?? config.consent;
      _remoteConfig =
          RemoteConfig.tryDecode(await store.getString(_configKey)) ??
          const RemoteConfig();
      _sampledIn = _remoteConfig.keepsDevice(_identity.anonymousId);
      _context = await _loadContext();
      await _queue.load();
      if (_consent == RabolicConsent.denied || !_collecting) _queue.clear();

      await _startSession();
      await _trackLaunch();
      _services.lifecycle.start(
        onForeground: () => _call('foreground', _onForeground),
        onBackground: () => _call('background', _onBackground),
      );
      final interval =
          config.flushInterval ??
          Duration(seconds: _platform == RabolicPlatform.web ? 5 : 15);
      _flushTimer = Timer.periodic(
        interval,
        (_) => unawaited(_uploader.flush()),
      );

      _isReady = true;
      for (final call in _beforeReady) {
        _guard(call);
      }
      _beforeReady.clear();

      unawaited(_refreshRemoteConfig());
      unawaited(_uploader.flush());
    } on Object catch (error) {
      _inert = true;
      _logger.error('could not start, so tracking is off: $error');
    }
  }

  Future<Map<String, Object?>> _loadContext() async {
    try {
      final context = await _services.contextLoader.load(_platform);
      return <String, Object?>{...context, 'platform': _platform.wireName};
    } on Object {
      return <String, Object?>{'platform': _platform.wireName};
    }
  }

  Future<void> _startSession() async {
    if (_platform == RabolicPlatform.web) {
      await _session.restoreWeb();
      final landing = _services.landingUri;
      if (landing != null) {
        _session.onWebLanding(campaignFromUri(landing), _launchTime);
      }
    } else {
      _session.start(_launchTime);
    }
  }

  /// `$app_first_open` or `$app_update`, then `$app_open`, all at launch
  /// time so they come before any call made while the client was loading.
  Future<void> _trackLaunch() async {
    if (!_platform.isMobile) return;
    final store = _services.keyValueStore;
    final installed = await store.getString(_installedKey) != null;
    final previousVersion = await store.getString(_appVersionKey);
    final app = _context['app'];
    final version = app is Map<String, Object?>
        ? app['version'] as String?
        : null;

    if (!installed) {
      _lifecycleEvent(_launchTime, r'$app_first_open');
      unawaited(_quietly(store.setString(_installedKey, '1')));
    } else if (version != null &&
        previousVersion != null &&
        version != previousVersion) {
      _lifecycleEvent(_launchTime, r'$app_update', <String, Object?>{
        'previous_version': previousVersion,
      });
    }
    if (version != null) {
      unawaited(_quietly(store.setString(_appVersionKey, version)));
    }

    // A launch straight into the background (a push or background fetch)
    // isn't an open; `$app_open` waits until the app is shown.
    if (_services.lifecycle.isInForeground) {
      _lifecycleEvent(_launchTime, r'$app_open', <String, Object?>{
        'from_background': false,
      });
      _foregroundSince = _launchTime;
    } else {
      _inForeground = false;
      _launchOpenPending = true;
      _backgroundSince = _launchTime;
    }
  }

  // ---------------------------------------------------------------------
  // Lifecycle

  void _onForeground(DateTime now) {
    if (_inForeground) return;
    _inForeground = true;
    final backgroundSince = _backgroundSince;
    _backgroundSince = null;
    _foregroundSince = now;

    if (_platform == RabolicPlatform.web) {
      // Another tab may have moved the shared session on meanwhile.
      unawaited(_session.restoreWeb());
    } else if (backgroundSince != null &&
        now.difference(backgroundSince) >
            Duration(seconds: _remoteConfig.sessionBackgroundSec)) {
      _session.start(now);
    }

    _lifecycleEvent(now, r'$app_open', <String, Object?>{
      'from_background': !_launchOpenPending,
    });
    _launchOpenPending = false;

    final fetchedAt = _configFetchedAt;
    if (fetchedAt == null || now.difference(fetchedAt) > remoteConfigMaxAge) {
      unawaited(_refreshRemoteConfig());
    }
  }

  void _onBackground(DateTime now) {
    if (!_inForeground) return;
    _inForeground = false;
    final foregroundSince = _foregroundSince;
    if (foregroundSince != null) {
      _lifecycleEvent(now, r'$app_background', <String, Object?>{
        'foreground_ms': now.difference(foregroundSince).inMilliseconds,
      });
    }
    _foregroundSince = null;
    _backgroundSince = now;
    unawaited(_uploader.flush());
  }

  void _lifecycleEvent(
    DateTime now,
    String name, [
    Map<String, Object?>? properties,
  ]) {
    final enabled =
        config.trackLifecycle && _remoteConfig.lifecycle && _platform.isMobile;
    if (enabled) {
      _enqueue(now, type: 'track', name: name, properties: properties);
    }
  }

  // ---------------------------------------------------------------------
  // Events

  /// Whether events are created at all.
  bool get _collecting =>
      _consent != RabolicConsent.denied && _remoteConfig.enabled && _sampledIn;

  bool get _canSend =>
      !_closed && _consent == RabolicConsent.granted && _collecting;

  Duration get _webSessionTimeout =>
      Duration(minutes: _remoteConfig.sessionTimeoutWebMin);

  void _enqueue(
    DateTime now, {
    required String type,
    required String name,
    Map<String, Object?>? properties,
    Map<String, Object?>? traits,
    Map<String, Object?>? context,
  }) {
    if (!_collecting) {
      _logger.debug('"$name" not recorded: ${_notCollectingReason()}');
      return;
    }
    if (_remoteConfig.blockedEvents.contains(name)) {
      _logger.debug('"$name" not recorded: blocked in project settings');
      return;
    }
    if (_platform == RabolicPlatform.web) {
      _session.touchWeb(now, _webSessionTimeout);
    }

    final cleanProperties = sanitizeProperties(<String, Object?>{
      ..._identity.superProperties,
      ...?properties,
    }, (problem) => _logger.debug('"$name": $problem'));
    final cleanTraits = traits == null
        ? null
        : sanitizeProperties(
            traits,
            (problem) => _logger.debug('"$name" traits: $problem'),
          );
    final id = _services.ids.uuidV7(now);
    final event = <String, Object?>{
      'event_id': id,
      'type': type,
      'event': name,
      'timestamp': formatTimestamp(now),
      'anonymous_id': _identity.anonymousId,
      'user_id': ?_identity.userId,
      'session_id': ?_session.id,
      if (cleanProperties.isNotEmpty) 'properties': cleanProperties,
      if (cleanTraits != null && cleanTraits.isNotEmpty) 'traits': cleanTraits,
      'context': <String, Object?>{..._context, ...?context},
    };

    final json = jsonEncode(event);
    final queued = QueuedEvent(id: id, timestamp: now, json: json);
    if (queued.bytes > Limits.eventBytes) {
      _logger.error(
        '"$name" dropped: ${queued.bytes} bytes is over the '
        '${Limits.eventBytes ~/ 1024} KB event limit',
      );
      return;
    }

    if (_consent == RabolicConsent.pending) {
      _pendingConsent.add(queued);
      if (_pendingConsent.length > _queue.maxSize) _pendingConsent.removeAt(0);
      return;
    }
    _queue.add(queued);
    if (_queue.length >= config.flushAt) unawaited(_uploader.flush());
  }

  String _notCollectingReason() {
    if (_consent == RabolicConsent.denied) return 'consent is denied';
    if (!_remoteConfig.enabled) return 'the project is disabled';
    return 'this device is outside the sample rate';
  }

  void _applyConsent(RabolicConsent consent) {
    _consent = consent;
    switch (consent) {
      case RabolicConsent.granted:
        if (!_collecting) {
          _pendingConsent.clear();
          return;
        }
        _queue.addAll(_pendingConsent);
        _pendingConsent.clear();
        unawaited(_uploader.flush());
      case RabolicConsent.pending:
        break;
      case RabolicConsent.denied:
        _pendingConsent.clear();
        _queue.clear();
    }
  }

  // ---------------------------------------------------------------------
  // Remote config

  Future<void> _refreshRemoteConfig() => _configFetch ??= _fetchRemoteConfig()
      .catchError((Object error) => _logger.debug('config failed: $error'))
      .whenComplete(() => _configFetch = null);

  Future<void> _fetchRemoteConfig() async {
    if (_closed || _uploader.isUnauthorized) return;
    final response = await _transport.fetchConfig();
    if (response.statusCode == 401) {
      _uploader.markUnauthorized();
      return;
    }
    final body = response.body;
    if (body == null) return;
    _configFetchedAt = _services.clock();
    unawaited(
      _quietly(_services.keyValueStore.setString(_configKey, jsonEncode(body))),
    );
    _applyRemoteConfig(RemoteConfig.fromJson(body));
  }

  void _applyRemoteConfig(RemoteConfig remoteConfig) {
    _remoteConfig = remoteConfig;
    _sampledIn = remoteConfig.keepsDevice(_identity.anonymousId);
    if (!_collecting) {
      _logger.debug('not sending: ${_notCollectingReason()}');
      _queue.clear();
      _pendingConsent.clear();
    }
  }

  // ---------------------------------------------------------------------
  // Plumbing

  /// Runs [operation] with the time of the call, now or once [ready].
  void _call(String description, void Function(DateTime now) operation) {
    _guard(() {
      if (_inert || _closed) return;
      final now = _services.clock();
      _logger.debug(description);
      if (_isReady) {
        operation(now);
      } else {
        _beforeReady.add(() => operation(now));
      }
    });
  }

  void _guard(void Function() action) {
    try {
      action();
    } on Object catch (error) {
      _logger.error('internal error, call ignored: $error');
    }
  }

  static RabolicConsent? _parseConsent(String? name) {
    for (final consent in RabolicConsent.values) {
      if (consent.name == name) return consent;
    }
    return null;
  }

  static Future<void> _quietly(Future<void> write) =>
      write.catchError((Object _) {});
}
