import 'dart:async';
import 'dart:convert';

import 'ids.dart';
import 'storage/key_value_store.dart';

/// Who the events are about: the anonymous id, the user id, the app account
/// token and the super properties, all persisted.
class Identity {
  /// Creates an identity backed by [store].
  Identity({required KeyValueStore store, required IdGenerator ids})
    : _store = store,
      _ids = ids;

  static const String _anonymousIdKey = 'rb_aid';
  static const String _userIdKey = 'rb_uid';
  static const String _accountTokenKey = 'rb_account_token';
  static const String _superPropertiesKey = 'rb_super_properties';

  final KeyValueStore _store;
  final IdGenerator _ids;

  late String _anonymousId;
  String? _userId;
  String? _accountToken;
  Map<String, Object?> _superProperties = <String, Object?>{};

  /// The persisted UUIDv4 anonymous id.
  String get anonymousId => _anonymousId;

  /// The id passed to the last `identify`, or `null`.
  String? get userId => _userId;

  /// The stable UUID for the identified person, or `null` when no one is
  /// identified.
  String? get appAccountToken => _accountToken;

  /// Properties added to every event.
  Map<String, Object?> get superProperties =>
      Map<String, Object?>.unmodifiable(_superProperties);

  /// Loads the stored identity, creating an anonymous id on first use.
  Future<void> load() async {
    final storedAnonymousId = await _store.getString(_anonymousIdKey);
    if (storedAnonymousId == null || storedAnonymousId.isEmpty) {
      _anonymousId = _ids.uuidV4();
      _save(_anonymousIdKey, _anonymousId);
    } else {
      _anonymousId = storedAnonymousId;
    }
    _userId = await _store.getString(_userIdKey);

    // The token is stored with the user it belongs to, so a stale token
    // can never be handed out for a different person.
    final token = _decodeMap(await _store.getString(_accountTokenKey));
    if (_userId != null &&
        token?['user_id'] == _userId &&
        token?['token'] is String) {
      _accountToken = token!['token']! as String;
    }
    _superProperties =
        _decodeMap(await _store.getString(_superPropertiesKey)) ??
        <String, Object?>{};
  }

  /// Sets the user id. A different person gets a new app account token.
  void identify(String userId) {
    if (_userId != userId || _accountToken == null) {
      _accountToken = _ids.uuidV4();
      _save(
        _accountTokenKey,
        jsonEncode(<String, String>{
          'user_id': userId,
          'token': _accountToken!,
        }),
      );
    }
    _userId = userId;
    _save(_userIdKey, userId);
  }

  /// Forgets the person: a new anonymous id, no user id, no app account
  /// token and no super properties.
  void reset() {
    _anonymousId = _ids.uuidV4();
    _userId = null;
    _accountToken = null;
    _superProperties = <String, Object?>{};
    _save(_anonymousIdKey, _anonymousId);
    _remove(_userIdKey);
    _remove(_accountTokenKey);
    _remove(_superPropertiesKey);
  }

  /// Adds or replaces super properties.
  void register(Map<String, Object?> properties) {
    _superProperties = <String, Object?>{..._superProperties, ...properties};
    _save(_superPropertiesKey, jsonEncode(_superProperties));
  }

  /// Removes the super property [key].
  void unregister(String key) {
    if (_superProperties.remove(key) == null) return;
    _save(_superPropertiesKey, jsonEncode(_superProperties));
  }

  void _save(String key, String value) =>
      unawaited(_store.setString(key, value).catchError((_) {}));

  void _remove(String key) => unawaited(_store.remove(key).catchError((_) {}));

  static Map<String, Object?>? _decodeMap(String? text) {
    if (text == null) return null;
    try {
      final decoded = jsonDecode(text);
      return decoded is Map<String, Object?> ? decoded : null;
    } on FormatException {
      return null;
    }
  }
}
