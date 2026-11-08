import 'dart:async';
import 'dart:convert';

import 'ids.dart';
import 'storage/key_value_store.dart';

/// Keeps the current session id (protocol §4).
///
/// The rules differ by platform, so the client decides when a session
/// starts: on iOS and Android at launch and after a long background; on the
/// web after inactivity ([touchWeb]) or a new campaign ([onWebLanding]).
/// Web sessions live in storage (`localStorage`) so tabs share them.
class SessionTracker {
  /// Creates a tracker.
  SessionTracker({required IdGenerator ids, required KeyValueStore store})
    : _ids = ids,
      _store = store;

  static const String _idKey = 'rb_sid';
  static const String _lastActivityKey = 'rb_last_activity';
  static const String _campaignKey = 'rb_session_campaign';

  final IdGenerator _ids;
  final KeyValueStore _store;

  String? _id;
  DateTime? _lastActivity;
  String? _campaign;

  /// The current session id, or `null` before the first session starts.
  String? get id => _id;

  /// Starts a new session at [now].
  void start(DateTime now) {
    _id = _ids.uuidV7(now);
    _lastActivity = now;
  }

  /// Reloads the web session another tab may have advanced.
  Future<void> restoreWeb() async {
    final id = await _store.getString(_idKey);
    final last = int.tryParse(await _store.getString(_lastActivityKey) ?? '');
    _campaign = await _store.getString(_campaignKey);
    if (id == null || last == null) return;
    final lastActivity = DateTime.fromMillisecondsSinceEpoch(last);
    if (_lastActivity == null || lastActivity.isAfter(_lastActivity!)) {
      _id = id;
      _lastActivity = lastActivity;
    }
  }

  /// Starts a web session when the page arrives with campaign parameters
  /// that differ from the current session's.
  void onWebLanding(Map<String, String> campaign, DateTime now) {
    if (campaign.isEmpty) return;
    final encoded = jsonEncode(campaign);
    if (encoded == _campaign) return;
    _campaign = encoded;
    unawaited(_quietly(_store.setString(_campaignKey, encoded)));
    start(now);
    _saveWeb();
  }

  /// Applies the web inactivity rule before an event at [now], then records
  /// the activity.
  void touchWeb(DateTime now, Duration timeout) {
    final last = _lastActivity;
    if (_id == null || last == null || now.difference(last) > timeout) {
      start(now);
    }
    _lastActivity = now;
    _saveWeb();
  }

  void _saveWeb() {
    unawaited(_quietly(_store.setString(_idKey, _id!)));
    unawaited(
      _quietly(
        _store.setString(
          _lastActivityKey,
          _lastActivity!.millisecondsSinceEpoch.toString(),
        ),
      ),
    );
  }

  static Future<void> _quietly(Future<void> write) => write.catchError((_) {});
}
